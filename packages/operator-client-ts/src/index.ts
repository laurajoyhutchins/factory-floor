export type OperatorFailureKind =
  'transport' | 'http' | 'malformed-response' | 'not-found' | 'aborted';

export class OperatorApiError extends Error {
  constructor(
    readonly kind: OperatorFailureKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OperatorApiError';
  }
}

export type InspectionRecord = Record<string, unknown>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageOptions = { cursor?: string | null; limit?: number };
export type TemplateInstantiationScope = {
  regionId?: string;
  runId?: string;
};
export type RunTopologyOptions = {
  regionLimit?: number;
  componentLimit?: number;
  connectionLimit?: number;
  recordLimit?: number;
};
export type FiniteRunEventPage = Page<InspectionRecord> & {
  resumeCursor: string | null;
  complete: boolean;
};
export type MergedRunEvents = {
  items: InspectionRecord[];
  resumeCursor: string | null;
  complete: boolean;
};

export type OperatorClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | ((accept: string) => HeadersInit);
  retryAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const opaqueRuntimeFields = new Set([
  'attributes',
  'configuration',
  'definition',
  'failure',
  'input_payload',
  'inputPayload',
  'metadata',
  'modifications',
  'normalized_inputs',
  'normalizedInputs',
  'payload',
  'provenance',
  'result',
  'schema',
  'topology',
]);

const camel = (value: string) =>
  value.replace(/_([a-z])/g, (_match, character: string) =>
    character.toUpperCase(),
  );

export function normalizeOperatorResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOperatorResponse);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        camel(key),
        opaqueRuntimeFields.has(key) ? child : normalizeOperatorResponse(child),
      ]),
    );
  }
  return value;
}

export function shortOperatorId(value: unknown) {
  const text = String(value ?? '');
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

function isRecord(value: unknown): value is InspectionRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value: unknown, description: string): InspectionRecord {
  if (!isRecord(value)) {
    throw new OperatorApiError(
      'malformed-response',
      `Expected ${description} to be an object.`,
    );
  }
  return value;
}

function assertPage(value: unknown, description = 'a paged response') {
  const record = assertRecord(value, description);
  if (
    !Array.isArray(record.items) ||
    !record.items.every(isRecord) ||
    !('nextCursor' in record) ||
    (record.nextCursor !== null && typeof record.nextCursor !== 'string')
  ) {
    throw new OperatorApiError(
      'malformed-response',
      `Expected ${description}.`,
    );
  }
  return {
    items: record.items,
    nextCursor: record.nextCursor,
  } satisfies Page<InspectionRecord>;
}

function assertFiniteRunEventPage(value: unknown): FiniteRunEventPage {
  const page = assertPage(value, 'a finite run-event page');
  const record = value as InspectionRecord;
  if (
    !('resumeCursor' in record) ||
    (record.resumeCursor !== null && typeof record.resumeCursor !== 'string') ||
    typeof record.complete !== 'boolean'
  ) {
    throw new OperatorApiError(
      'malformed-response',
      'Expected a finite run-event page.',
    );
  }
  return {
    ...page,
    resumeCursor: record.resumeCursor,
    complete: record.complete,
  };
}

function errorDetails(body: unknown): { code?: string; message?: string } {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  return {
    code: typeof body.error.code === 'string' ? body.error.code : undefined,
    message:
      typeof body.error.message === 'string' ? body.error.message : undefined,
  };
}

export function shouldRetryOperatorRequest(
  error: unknown,
  attempt: number,
  maximumAttempts = 2,
) {
  if (attempt >= maximumAttempts || !(error instanceof OperatorApiError)) {
    return false;
  }
  return (
    error.kind === 'transport' ||
    (error.kind === 'http' && (error.status ?? 0) >= 500)
  );
}

export function mergeFiniteRunEvents(
  current: InspectionRecord[],
  page: FiniteRunEventPage,
  maximum = 100,
): MergedRunEvents {
  const byId = new Map<string, InspectionRecord>();
  for (const event of [...current, ...page.items]) {
    const id = typeof event.id === 'string' ? event.id : '';
    if (id && !byId.has(id)) byId.set(id, event);
  }
  const anonymous = [...current, ...page.items].filter(
    (event) => typeof event.id !== 'string' || event.id.length === 0,
  );
  return {
    items: [...byId.values(), ...anonymous].slice(-Math.max(1, maximum)),
    resumeCursor: page.resumeCursor,
    complete: page.complete,
  };
}

export type StreamState =
  'connecting' | 'live' | 'reconnecting' | 'disconnected';
export type RuntimeEvent = { id?: string; [key: string]: unknown };

export function appendDedupedRunEvents(
  buffer: RuntimeEvent[],
  incoming: RuntimeEvent[],
  maximum: number,
) {
  const seen = new Set(buffer.map((event) => String(event.id ?? '')));
  const merged = [...buffer];
  for (const event of incoming) {
    const id = String(event.id ?? '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.unshift(event);
  }
  return merged.slice(0, Math.max(1, maximum));
}

export function parseOperatorSseBatch(text: string) {
  const events: RuntimeEvent[] = [];
  let cursor: string | null = null;
  for (const frame of text.replaceAll('\r\n', '\n').split('\n\n')) {
    if (!frame.trim() || frame.startsWith(':')) continue;
    const lines = frame.split('\n');
    const id = lines
      .find((line) => line.startsWith('id:'))
      ?.slice(3)
      .trim();
    const eventType = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (id) cursor = id;
    if (!data) continue;
    const parsed = JSON.parse(data) as RuntimeEvent & {
      nextCursor?: string | null;
    };
    if (eventType === 'checkpoint' || 'nextCursor' in parsed) {
      cursor = parsed.nextCursor ?? cursor;
      continue;
    }
    events.push({ ...parsed, id: parsed.id ?? id });
  }
  return { events, cursor };
}

const inspectionPaths = {
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
  instantiations: '/api/v1/inspect/instantiations',
  stream: '/api/v1/inspect/stream',
} as const;

function pageUrl(path: string, options: PageOptions = {}) {
  const url = new URL(path, 'http://factory-floor.local');
  if (options.cursor !== undefined && options.cursor !== null) {
    url.searchParams.set('cursor', options.cursor);
  }
  if (options.limit !== undefined) {
    url.searchParams.set('limit', String(options.limit));
  }
  return url.pathname + url.search;
}

function runPath(runId: string, suffix = '') {
  return `/api/v1/operator/runs/${encodeURIComponent(runId)}${suffix}`;
}

export function createOperatorClient(options: OperatorClientOptions = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maximumAttempts = Math.max(1, options.retryAttempts ?? 1);
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const headers = (accept: string): Record<string, string> => {
    const configured =
      typeof options.headers === 'function'
        ? options.headers(accept)
        : options.headers;
    const result = new Headers(configured);
    result.set('accept', accept);
    return Object.fromEntries(result.entries());
  };

  const target = (path: string) =>
    options.baseUrl ? new URL(path, options.baseUrl).toString() : path;

  const requestJson = async (
    path: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        let response: Response;
        try {
          response = await fetchImplementation(target(path), {
            method: 'GET',
            signal,
            headers: headers('application/json'),
          });
        } catch (error) {
          if ((error as Error).name === 'AbortError') {
            throw new OperatorApiError('aborted', 'Request was cancelled.');
          }
          throw new OperatorApiError(
            'transport',
            'Unable to reach the control plane.',
          );
        }

        const text = await response.text();
        let body: unknown = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            if (!response.ok) {
              throw new OperatorApiError(
                'http',
                `The control plane returned HTTP ${response.status}.`,
                response.status,
              );
            }
            throw new OperatorApiError(
              'malformed-response',
              'The control plane returned malformed JSON.',
              response.status,
            );
          }
        }

        if (!response.ok) {
          const details = errorDetails(body);
          throw new OperatorApiError(
            response.status === 404 ? 'not-found' : 'http',
            details.message ??
              `The control plane returned HTTP ${response.status}.`,
            response.status,
            details.code,
          );
        }
        return normalizeOperatorResponse(body);
      } catch (error) {
        if (!shouldRetryOperatorRequest(error, attempt, maximumAttempts)) {
          throw error;
        }
        await sleep(Math.max(0, options.retryDelayMs ?? 0));
      }
    }
  };

  const getPage = async (
    path: string,
    pageOptions?: PageOptions,
    signal?: AbortSignal,
  ) => assertPage(await requestJson(pageUrl(path, pageOptions), signal));

  return {
    headers,
    streamPath: inspectionPaths.stream,
    health: async (signal?: AbortSignal) => {
      const value = assertRecord(
        await requestJson(inspectionPaths.health, signal),
        'health',
      );
      if (
        typeof value.status !== 'string' ||
        typeof value.service !== 'string'
      ) {
        throw new OperatorApiError(
          'malformed-response',
          'The control-plane health response is incomplete.',
        );
      }
      return { status: value.status, service: value.service };
    },
    regions: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage(inspectionPaths.regions, pageOptions, signal),
    events: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage(inspectionPaths.events, pageOptions, signal),
    deliveries: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage(inspectionPaths.deliveries, pageOptions, signal),
    executions: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage(inspectionPaths.executions, pageOptions, signal),
    execution: async (id: string, signal?: AbortSignal) =>
      assertRecord(
        await requestJson(
          `${inspectionPaths.executions}/${encodeURIComponent(id)}`,
          signal,
        ),
        'an execution trace',
      ),
    executionAttempts: (
      id: string,
      pageOptions?: PageOptions,
      signal?: AbortSignal,
    ) =>
      getPage(
        `${inspectionPaths.executions}/${encodeURIComponent(id)}/attempts`,
        pageOptions,
        signal,
      ),
    attempts: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage(inspectionPaths.attempts, pageOptions, signal),
    artifacts: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage(inspectionPaths.artifacts, pageOptions, signal),
    artifactLineage: async (id: string, signal?: AbortSignal) =>
      assertRecord(
        await requestJson(
          `${inspectionPaths.artifacts}/${encodeURIComponent(id)}/lineage`,
          signal,
        ),
        'artifact lineage',
      ),
    resources: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage(inspectionPaths.resources, pageOptions, signal),
    policyDecisions: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage(inspectionPaths.policies, pageOptions, signal),
    projections: async (signal?: AbortSignal) => {
      const value = assertRecord(
        await requestJson(inspectionPaths.projections, signal),
        'projection status',
      );
      if (!Array.isArray(value.items) || !value.items.every(isRecord)) {
        throw new OperatorApiError(
          'malformed-response',
          'The projection response is incomplete.',
        );
      }
      return { items: value.items };
    },
    topology: async (signal?: AbortSignal) =>
      assertRecord(
        await requestJson(inspectionPaths.topology, signal),
        'active topology',
      ),
    templateInstantiations: async (
      scope: TemplateInstantiationScope,
      pageOptions: PageOptions = {},
      signal?: AbortSignal,
    ) => {
      const url = new URL(
        pageUrl(inspectionPaths.instantiations, pageOptions),
        'http://factory-floor.local',
      );
      if (scope.regionId) url.searchParams.set('regionId', scope.regionId);
      if (scope.runId) url.searchParams.set('runId', scope.runId);
      return assertPage(await requestJson(url.pathname + url.search, signal));
    },
    templateInstantiation: async (id: string, signal?: AbortSignal) =>
      assertRecord(
        await requestJson(
          `${inspectionPaths.instantiations}/${encodeURIComponent(id)}`,
          signal,
        ),
        'a template instantiation',
      ),
    operatorStatus: async (signal?: AbortSignal) =>
      assertRecord(
        await requestJson('/api/v1/operator/status', signal),
        'operator status',
      ),
    runStatus: async (runId: string, signal?: AbortSignal) =>
      assertRecord(await requestJson(runPath(runId), signal), 'run status'),
    runTrace: async (runId: string, signal?: AbortSignal) =>
      assertRecord(
        await requestJson(runPath(runId, '/trace'), signal),
        'run trace',
      ),
    runTopology: async (
      runId: string,
      topologyOptions: RunTopologyOptions = {},
      signal?: AbortSignal,
    ) => {
      const url = new URL(
        runPath(runId, '/topology'),
        'http://factory-floor.local',
      );
      for (const [key, value] of Object.entries(topologyOptions)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      return assertRecord(
        await requestJson(url.pathname + url.search, signal),
        'run topology',
      );
    },
    runAlerts: (
      runId: string,
      pageOptions?: PageOptions,
      signal?: AbortSignal,
    ) => getPage(runPath(runId, '/alerts'), pageOptions, signal),
    runEvents: async (
      runId: string,
      pageOptions?: PageOptions,
      signal?: AbortSignal,
    ) =>
      assertFiniteRunEventPage(
        await requestJson(
          pageUrl(runPath(runId, '/events'), pageOptions),
          signal,
        ),
      ),
    runInstantiations: (
      runId: string,
      pageOptions?: PageOptions,
      signal?: AbortSignal,
    ) => getPage(runPath(runId, '/instantiations'), pageOptions, signal),
    runArtifacts: (
      runId: string,
      pageOptions?: PageOptions,
      signal?: AbortSignal,
    ) => getPage(runPath(runId, '/artifacts'), pageOptions, signal),
    readRunArtifact: async (
      runId: string,
      artifactId: string,
      maximumBytes?: number,
      signal?: AbortSignal,
    ) => {
      const url = new URL(
        runPath(runId, `/artifacts/${encodeURIComponent(artifactId)}`),
        'http://factory-floor.local',
      );
      if (maximumBytes !== undefined) {
        url.searchParams.set('maxBytes', String(maximumBytes));
      }
      return assertRecord(
        await requestJson(url.pathname + url.search, signal),
        'a run artifact',
      );
    },
    approvals: (pageOptions?: PageOptions, signal?: AbortSignal) =>
      getPage('/api/v1/operator/approvals', pageOptions, signal),
  };
}

export type OperatorClient = ReturnType<typeof createOperatorClient>;
export const readOnlyInspectionPaths = inspectionPaths;
