import { normalize } from './adapters.js';

export type ApiFailureKind =
  'transport' | 'http' | 'malformed-response' | 'not-found' | 'aborted';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type InspectionRecord = Record<string, unknown>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageOptions = { cursor?: string | null; limit?: number };

const paths = {
  health: '/health',
  regions: '/api/v1/inspect/regions',
  events: '/api/v1/inspect/events',
  deliveries: '/api/v1/inspect/deliveries',
  executions: '/api/v1/inspect/executions',
  attempts: '/api/v1/inspect/attempts',
  artifacts: '/api/v1/inspect/artifacts',
  resources: '/api/v1/inspect/resources',
  policies: '/api/v1/inspect/policy-decisions',
  projections: '/api/v1/inspect/projections',
  topology: '/api/v1/inspect/topology',
  stream: '/api/v1/inspect/stream',
} as const;

const operatorToken = import.meta.env.VITE_FACTORY_FLOOR_OPERATOR_TOKEN?.trim();

export function inspectionHeaders(accept: string): Record<string, string> {
  return {
    accept,
    ...(operatorToken ? { authorization: `Bearer ${operatorToken}` } : {}),
  };
}

function isRecord(value: unknown): value is InspectionRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pageUrl(path: string, opts: PageOptions = {}) {
  const url = new URL(path, 'http://factory-floor.local');
  if (opts.cursor !== undefined && opts.cursor !== null)
    url.searchParams.set('cursor', opts.cursor);
  if (opts.limit !== undefined)
    url.searchParams.set('limit', String(opts.limit));
  return url.pathname + url.search;
}

function errorDetails(body: unknown): { code?: string; message?: string } {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  return {
    code: typeof body.error.code === 'string' ? body.error.code : undefined,
    message:
      typeof body.error.message === 'string' ? body.error.message : undefined,
  };
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      signal,
      headers: inspectionHeaders('application/json'),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError')
      throw new ApiError('aborted', 'Request was cancelled.');
    throw new ApiError('transport', 'Unable to reach the control plane.');
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok)
        throw new ApiError(
          'http',
          `The control plane returned HTTP ${response.status}.`,
          response.status,
        );
      throw new ApiError(
        'malformed-response',
        'The control plane returned malformed JSON.',
        response.status,
      );
    }
  }

  if (!response.ok) {
    const details = errorDetails(body);
    throw new ApiError(
      response.status === 404 ? 'not-found' : 'http',
      details.message ?? `The control plane returned HTTP ${response.status}.`,
      response.status,
      details.code,
    );
  }

  return normalize(body);
}

function assertRecord(value: unknown, description: string): InspectionRecord {
  if (!isRecord(value))
    throw new ApiError(
      'malformed-response',
      `Expected ${description} to be an object.`,
    );
  return value;
}

function assertPage(value: unknown): Page<InspectionRecord> {
  const record = assertRecord(value, 'a paged inspection response');
  if (
    !Array.isArray(record.items) ||
    !record.items.every(isRecord) ||
    !('nextCursor' in record) ||
    (record.nextCursor !== null && typeof record.nextCursor !== 'string')
  )
    throw new ApiError(
      'malformed-response',
      'Expected a paged inspection response.',
    );
  return {
    items: record.items,
    nextCursor: record.nextCursor,
  };
}

async function getPage(
  path: string,
  options?: PageOptions,
  signal?: AbortSignal,
): Promise<Page<InspectionRecord>> {
  return assertPage(await getJson(pageUrl(path, options), signal));
}

export const consoleApi = {
  health: async (signal?: AbortSignal) => {
    const value = assertRecord(await getJson(paths.health, signal), 'health');
    if (typeof value.status !== 'string' || typeof value.service !== 'string')
      throw new ApiError(
        'malformed-response',
        'The control-plane health response is incomplete.',
      );
    return { status: value.status, service: value.service };
  },
  regions: (options?: PageOptions, signal?: AbortSignal) =>
    getPage(paths.regions, options, signal),
  events: (options?: PageOptions, signal?: AbortSignal) =>
    getPage(paths.events, options, signal),
  deliveries: (options?: PageOptions, signal?: AbortSignal) =>
    getPage(paths.deliveries, options, signal),
  executions: (options?: PageOptions, signal?: AbortSignal) =>
    getPage(paths.executions, options, signal),
  execution: async (id: string, signal?: AbortSignal) =>
    assertRecord(
      await getJson(`${paths.executions}/${encodeURIComponent(id)}`, signal),
      'an execution trace',
    ),
  executionAttempts: (
    id: string,
    options?: PageOptions,
    signal?: AbortSignal,
  ) =>
    getPage(
      `${paths.executions}/${encodeURIComponent(id)}/attempts`,
      options,
      signal,
    ),
  attempts: (options?: PageOptions, signal?: AbortSignal) =>
    getPage(paths.attempts, options, signal),
  artifacts: (options?: PageOptions, signal?: AbortSignal) =>
    getPage(paths.artifacts, options, signal),
  artifactLineage: async (id: string, signal?: AbortSignal) =>
    assertRecord(
      await getJson(
        `${paths.artifacts}/${encodeURIComponent(id)}/lineage`,
        signal,
      ),
      'artifact lineage',
    ),
  resources: (options?: PageOptions, signal?: AbortSignal) =>
    getPage(paths.resources, options, signal),
  policyDecisions: (options?: PageOptions, signal?: AbortSignal) =>
    getPage(paths.policies, options, signal),
  projections: async (signal?: AbortSignal) => {
    const value = assertRecord(
      await getJson(paths.projections, signal),
      'projection status',
    );
    if (!Array.isArray(value.items) || !value.items.every(isRecord))
      throw new ApiError(
        'malformed-response',
        'The projection response is incomplete.',
      );
    return { items: value.items };
  },
  topology: async (signal?: AbortSignal) =>
    assertRecord(await getJson(paths.topology, signal), 'active topology'),
  streamPath: paths.stream,
};

export const readOnlyInspectionPaths = paths;
