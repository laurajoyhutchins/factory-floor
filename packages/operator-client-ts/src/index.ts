export type OperatorClientFailureKind =
  'transport' | 'http' | 'malformed-response' | 'not-found' | 'aborted';

export class OperatorClientError extends Error {
  constructor(
    readonly kind: OperatorClientFailureKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OperatorClientError';
  }
}

export { OperatorClientError as ApiError };
export type ApiFailureKind = OperatorClientFailureKind;
export type InspectionRecord = Record<string, unknown>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageOptions = { cursor?: string | null; limit?: number };
export type TemplateInstantiationScope = {
  regionId?: string;
  runId?: string;
};
export type RunEventPage<T extends InspectionRecord = InspectionRecord> =
  Page<T> & {
    resumeCursor: string | null;
    complete: boolean;
  };
export type DevelopmentTaskRequest = {
  clientRequestId: string;
  repository: string;
  objective: string;
  acceptanceCriteria: string[];
  authority?: {
    mayCreateBranch?: boolean;
    mayOpenDraftPullRequest?: boolean;
    mayMerge?: boolean;
  };
  metadata?: Record<string, string | number | boolean | null>;
};
export type ApprovalDecisionRequest = {
  clientRequestId: string;
  decision: 'approve' | 'reject';
  reason: string;
};
export type RunCancellationRequest = {
  clientRequestId: string;
  reason: string;
};
export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};
export type OperatorClientConfig = {
  baseUrl?: string;
  token?: string;
  principalId: string;
  adapter: string;
  fetch?: typeof globalThis.fetch;
  retry?: RetryOptions;
};

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
  instantiations: '/api/v1/inspect/instantiations',
  stream: '/api/v1/inspect/stream',
  operator: '/api/v1/operator',
} as const;

export const readOnlyInspectionPaths = paths;

const OPAQUE_RUNTIME_FIELDS = new Set([
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
  'value',
]);

export const camel = (value: string) =>
  value.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase());

export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        camel(key),
        OPAQUE_RUNTIME_FIELDS.has(key) ? child : normalize(child),
      ]),
    );
  return value;
}

export function shortId(value: unknown): string {
  const text = String(value ?? '');
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

function isRecord(value: unknown): value is InspectionRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value: unknown, description: string): InspectionRecord {
  if (!isRecord(value))
    throw new OperatorClientError(
      'malformed-response',
      `Expected ${description} to be an object.`,
    );
  return value;
}

function assertPage(value: unknown): Page<InspectionRecord> {
  const record = assertRecord(value, 'a paged operator response');
  if (
    !Array.isArray(record.items) ||
    !record.items.every(isRecord) ||
    !('nextCursor' in record) ||
    (record.nextCursor !== null && typeof record.nextCursor !== 'string')
  )
    throw new OperatorClientError(
      'malformed-response',
      'Expected a paged operator response.',
    );
  return {
    items: record.items,
    nextCursor: record.nextCursor,
  };
}

function assertRunEventPage(value: unknown): RunEventPage {
  const page = assertPage(value);
  const record = value as InspectionRecord;
  if (
    !('resumeCursor' in record) ||
    (record.resumeCursor !== null && typeof record.resumeCursor !== 'string') ||
    typeof record.complete !== 'boolean'
  )
    throw new OperatorClientError(
      'malformed-response',
      'Expected a finite run event response.',
    );
  return {
    ...page,
    resumeCursor: record.resumeCursor,
    complete: record.complete,
  };
}

function pagePath(path: string, options: PageOptions = {}): string {
  const url = new URL(path, 'http://factory-floor.local');
  if (options.cursor !== undefined && options.cursor !== null)
    url.searchParams.set('cursor', options.cursor);
  if (options.limit !== undefined)
    url.searchParams.set('limit', String(options.limit));
  return `${url.pathname}${url.search}`;
}

function withQuery(
  path: string,
  values: Record<string, string | number | null | undefined>,
): string {
  const url = new URL(path, 'http://factory-floor.local');
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null)
      url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}`;
}

function errorDetails(body: unknown): { code?: string; message?: string } {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  return {
    code: typeof body.error.code === 'string' ? body.error.code : undefined,
    message:
      typeof body.error.message === 'string' ? body.error.message : undefined,
  };
}

function normalizeBaseUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function targetUrl(baseUrl: string | undefined, path: string): string {
  return baseUrl ? new URL(path.replace(/^\//, ''), baseUrl).toString() : path;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface OperatorClient {
  inspectionHeaders(accept: string): Record<string, string>;
  health(signal?: AbortSignal): Promise<{ status: string; service: string }>;
  regions(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  events(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  deliveries(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  executions(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  execution(id: string, signal?: AbortSignal): Promise<InspectionRecord>;
  executionAttempts(
    id: string,
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  attempts(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  artifacts(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  artifactLineage(id: string, signal?: AbortSignal): Promise<InspectionRecord>;
  resources(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  policyDecisions(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  projections(signal?: AbortSignal): Promise<{ items: InspectionRecord[] }>;
  topology(signal?: AbortSignal): Promise<InspectionRecord>;
  templateInstantiations(
    scope: TemplateInstantiationScope,
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  templateInstantiation(
    id: string,
    signal?: AbortSignal,
  ): Promise<InspectionRecord>;
  readonly streamPath: string;
  operatorStatus(signal?: AbortSignal): Promise<InspectionRecord>;
  submitTask(
    request: DevelopmentTaskRequest,
    signal?: AbortSignal,
  ): Promise<InspectionRecord>;
  run(runId: string, signal?: AbortSignal): Promise<InspectionRecord>;
  runTrace(runId: string, signal?: AbortSignal): Promise<InspectionRecord>;
  runTopology(
    runId: string,
    options?: Record<string, number | undefined>,
    signal?: AbortSignal,
  ): Promise<InspectionRecord>;
  runAlerts(
    runId: string,
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  runEvents(
    runId: string,
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<RunEventPage>;
  runInstantiations(
    runId: string,
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  runArtifacts(
    runId: string,
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  runArtifact(
    runId: string,
    artifactId: string,
    maxBytes?: number,
    signal?: AbortSignal,
  ): Promise<InspectionRecord>;
  pendingApprovals(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
  decideApproval(
    approvalId: string,
    request: ApprovalDecisionRequest,
    signal?: AbortSignal,
  ): Promise<InspectionRecord>;
  cancelRun(
    runId: string,
    request: RunCancellationRequest,
    signal?: AbortSignal,
  ): Promise<InspectionRecord>;
}

export function createOperatorClient(
  config: OperatorClientConfig,
): OperatorClient {
  const principalId = config.principalId.trim();
  const adapter = config.adapter.trim();
  if (!principalId)
    throw new OperatorClientError(
      'malformed-response',
      'principalId is required.',
    );
  if (!adapter)
    throw new OperatorClientError('malformed-response', 'adapter is required.');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const token = config.token?.trim();
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  const maxAttempts = positiveInteger(config.retry?.maxAttempts, 3);
  const baseDelayMs = positiveInteger(config.retry?.baseDelayMs, 100);
  const sleep =
    config.retry?.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const headers = (
    accept: string,
    operator: boolean,
    body: boolean,
  ): Record<string, string> => ({
    accept,
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(operator
      ? {
          'x-factory-floor-principal-id': principalId,
          'x-factory-floor-adapter': adapter,
        }
      : {}),
  });

  const requestJson = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const operator = path.startsWith(paths.operator);
    const attempts = method === 'GET' ? maxAttempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImplementation(targetUrl(baseUrl, path), {
          method,
          signal,
          headers: headers('application/json', operator, body !== undefined),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError')
          throw new OperatorClientError('aborted', 'Request was cancelled.');
        if (attempt < attempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new OperatorClientError(
          'transport',
          'Unable to reach the control plane.',
        );
      }

      if (transientStatus(response.status) && attempt < attempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }

      const text = await response.text();
      let parsed: unknown = null;
      if (text)
        try {
          parsed = JSON.parse(text);
        } catch {
          if (!response.ok)
            throw new OperatorClientError(
              'http',
              `The control plane returned HTTP ${response.status}.`,
              response.status,
            );
          throw new OperatorClientError(
            'malformed-response',
            'The control plane returned malformed JSON.',
            response.status,
          );
        }

      if (!response.ok) {
        const details = errorDetails(parsed);
        throw new OperatorClientError(
          response.status === 404 ? 'not-found' : 'http',
          details.message ??
            `The control plane returned HTTP ${response.status}.`,
          response.status,
          details.code,
        );
      }
      return normalize(parsed);
    }
    throw new OperatorClientError(
      'transport',
      'Unable to reach the control plane.',
    );
  };

  const getRecord = async (
    path: string,
    description: string,
    signal?: AbortSignal,
  ) =>
    assertRecord(
      await requestJson('GET', path, undefined, signal),
      description,
    );
  const getPage = async (
    path: string,
    options?: PageOptions,
    signal?: AbortSignal,
  ) =>
    assertPage(
      await requestJson('GET', pagePath(path, options), undefined, signal),
    );
  const postRecord = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ) =>
    assertRecord(
      await requestJson('POST', path, body, signal),
      'an operator response',
    );

  return {
    inspectionHeaders: (accept) => headers(accept, false, false),
    health: async (signal) => {
      const value = await getRecord(paths.health, 'health', signal);
      if (typeof value.status !== 'string' || typeof value.service !== 'string')
        throw new OperatorClientError(
          'malformed-response',
          'The control-plane health response is incomplete.',
        );
      return { status: value.status, service: value.service };
    },
    regions: (options, signal) => getPage(paths.regions, options, signal),
    events: (options, signal) => getPage(paths.events, options, signal),
    deliveries: (options, signal) => getPage(paths.deliveries, options, signal),
    executions: (options, signal) => getPage(paths.executions, options, signal),
    execution: (id, signal) =>
      getRecord(
        `${paths.executions}/${encodeURIComponent(id)}`,
        'an execution trace',
        signal,
      ),
    executionAttempts: (id, options, signal) =>
      getPage(
        `${paths.executions}/${encodeURIComponent(id)}/attempts`,
        options,
        signal,
      ),
    attempts: (options, signal) => getPage(paths.attempts, options, signal),
    artifacts: (options, signal) => getPage(paths.artifacts, options, signal),
    artifactLineage: (id, signal) =>
      getRecord(
        `${paths.artifacts}/${encodeURIComponent(id)}/lineage`,
        'artifact lineage',
        signal,
      ),
    resources: (options, signal) => getPage(paths.resources, options, signal),
    policyDecisions: (options, signal) =>
      getPage(paths.policies, options, signal),
    projections: async (signal) => {
      const value = await getRecord(
        paths.projections,
        'projection status',
        signal,
      );
      if (!Array.isArray(value.items) || !value.items.every(isRecord))
        throw new OperatorClientError(
          'malformed-response',
          'The projection response is incomplete.',
        );
      return { items: value.items };
    },
    topology: (signal) => getRecord(paths.topology, 'active topology', signal),
    templateInstantiations: async (scope, options = {}, signal) => {
      const url = new URL(
        pagePath(paths.instantiations, options),
        'http://factory-floor.local',
      );
      if (scope.regionId) url.searchParams.set('regionId', scope.regionId);
      if (scope.runId) url.searchParams.set('runId', scope.runId);
      return assertPage(
        await requestJson(
          'GET',
          `${url.pathname}${url.search}`,
          undefined,
          signal,
        ),
      );
    },
    templateInstantiation: (id, signal) =>
      getRecord(
        `${paths.instantiations}/${encodeURIComponent(id)}`,
        'a template instantiation',
        signal,
      ),
    streamPath: paths.stream,
    operatorStatus: (signal) =>
      getRecord(`${paths.operator}/status`, 'operator status', signal),
    submitTask: (request, signal) =>
      postRecord(`${paths.operator}/tasks`, request, signal),
    run: (runId, signal) =>
      getRecord(
        `${paths.operator}/runs/${encodeURIComponent(runId)}`,
        'run status',
        signal,
      ),
    runTrace: (runId, signal) =>
      getRecord(
        `${paths.operator}/runs/${encodeURIComponent(runId)}/trace`,
        'run trace',
        signal,
      ),
    runTopology: (runId, options = {}, signal) =>
      getRecord(
        withQuery(
          `${paths.operator}/runs/${encodeURIComponent(runId)}/topology`,
          options,
        ),
        'run topology',
        signal,
      ),
    runAlerts: (runId, options, signal) =>
      getPage(
        `${paths.operator}/runs/${encodeURIComponent(runId)}/alerts`,
        options,
        signal,
      ),
    runEvents: async (runId, options, signal) =>
      assertRunEventPage(
        await requestJson(
          'GET',
          pagePath(
            `${paths.operator}/runs/${encodeURIComponent(runId)}/events`,
            options,
          ),
          undefined,
          signal,
        ),
      ),
    runInstantiations: (runId, options, signal) =>
      getPage(
        `${paths.operator}/runs/${encodeURIComponent(runId)}/instantiations`,
        options,
        signal,
      ),
    runArtifacts: (runId, options, signal) =>
      getPage(
        `${paths.operator}/runs/${encodeURIComponent(runId)}/artifacts`,
        options,
        signal,
      ),
    runArtifact: (runId, artifactId, maxBytes, signal) =>
      getRecord(
        withQuery(
          `${paths.operator}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
          { maxBytes },
        ),
        'a run artifact',
        signal,
      ),
    pendingApprovals: (options, signal) =>
      getPage(`${paths.operator}/approvals`, options, signal),
    decideApproval: (approvalId, request, signal) =>
      postRecord(
        `${paths.operator}/approvals/${encodeURIComponent(approvalId)}/decision`,
        request,
        signal,
      ),
    cancelRun: (runId, request, signal) =>
      postRecord(
        `${paths.operator}/runs/${encodeURIComponent(runId)}/cancel`,
        request,
        signal,
      ),
  };
}

let configuredClient: OperatorClient | undefined;

export function configureDefaultOperatorClient(client: OperatorClient): void {
  configuredClient = client;
}

function currentClient(): OperatorClient {
  if (!configuredClient)
    throw new OperatorClientError(
      'transport',
      'The default operator client has not been configured.',
    );
  return configuredClient;
}

export const operatorClient: OperatorClient = {
  inspectionHeaders: (accept) => currentClient().inspectionHeaders(accept),
  health: (...args) => currentClient().health(...args),
  regions: (...args) => currentClient().regions(...args),
  events: (...args) => currentClient().events(...args),
  deliveries: (...args) => currentClient().deliveries(...args),
  executions: (...args) => currentClient().executions(...args),
  execution: (...args) => currentClient().execution(...args),
  executionAttempts: (...args) => currentClient().executionAttempts(...args),
  attempts: (...args) => currentClient().attempts(...args),
  artifacts: (...args) => currentClient().artifacts(...args),
  artifactLineage: (...args) => currentClient().artifactLineage(...args),
  resources: (...args) => currentClient().resources(...args),
  policyDecisions: (...args) => currentClient().policyDecisions(...args),
  projections: (...args) => currentClient().projections(...args),
  topology: (...args) => currentClient().topology(...args),
  templateInstantiations: (...args) =>
    currentClient().templateInstantiations(...args),
  templateInstantiation: (...args) =>
    currentClient().templateInstantiation(...args),
  get streamPath() {
    return currentClient().streamPath;
  },
  operatorStatus: (...args) => currentClient().operatorStatus(...args),
  submitTask: (...args) => currentClient().submitTask(...args),
  run: (...args) => currentClient().run(...args),
  runTrace: (...args) => currentClient().runTrace(...args),
  runTopology: (...args) => currentClient().runTopology(...args),
  runAlerts: (...args) => currentClient().runAlerts(...args),
  runEvents: (...args) => currentClient().runEvents(...args),
  runInstantiations: (...args) => currentClient().runInstantiations(...args),
  runArtifacts: (...args) => currentClient().runArtifacts(...args),
  runArtifact: (...args) => currentClient().runArtifact(...args),
  pendingApprovals: (...args) => currentClient().pendingApprovals(...args),
  decideApproval: (...args) => currentClient().decideApproval(...args),
  cancelRun: (...args) => currentClient().cancelRun(...args),
};

export const consoleApi = operatorClient;

export function inspectionHeaders(accept: string): Record<string, string> {
  return currentClient().inspectionHeaders(accept);
}

export async function* paginate<T>(
  load: (options: PageOptions) => Promise<Page<T>>,
  options: PageOptions = {},
): AsyncGenerator<T, void, void> {
  let cursor = options.cursor ?? null;
  do {
    const page = await load({ ...options, cursor });
    for (const item of page.items) yield item;
    cursor = page.nextCursor;
  } while (cursor !== null);
}

export async function* iterateRunEvents(
  client: OperatorClient,
  runId: string,
  options: PageOptions = {},
): AsyncGenerator<InspectionRecord, string | null, void> {
  let cursor = options.cursor ?? null;
  const seen = new Set<string>();
  while (true) {
    const page = await client.runEvents(runId, { ...options, cursor });
    for (const event of page.items) {
      const id = typeof event.id === 'string' ? event.id : undefined;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      yield event;
    }
    if (!page.nextCursor) return page.resumeCursor;
    cursor = page.nextCursor;
  }
}
