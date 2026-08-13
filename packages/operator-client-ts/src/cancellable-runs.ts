import {
  OperatorClientError,
  normalize,
  type InspectionRecord,
  type OperatorClientConfig,
  type Page,
  type PageOptions,
} from './index.js';

export interface CancellableRunsClient {
  list(
    options?: PageOptions,
    signal?: AbortSignal,
  ): Promise<Page<InspectionRecord>>;
}

function targetUrl(baseUrl: string | undefined, path: string): string {
  return baseUrl ? new URL(path.replace(/^\//, ''), baseUrl).toString() : path;
}

function pagePath(options: PageOptions = {}): string {
  const url = new URL(
    '/api/v1/operator/cancellable-runs',
    'http://factory-floor.local',
  );
  if (options.cursor) url.searchParams.set('cursor', options.cursor);
  if (options.limit !== undefined)
    url.searchParams.set('limit', String(options.limit));
  return `${url.pathname}${url.search}`;
}

function isRecord(value: unknown): value is InspectionRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPage(value: unknown): Page<InspectionRecord> {
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new OperatorClientError(
      'malformed-response',
      'Expected a paged cancellable-run response.',
    );
  if (
    !value.items.every(isRecord) ||
    !('nextCursor' in value) ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string')
  )
    throw new OperatorClientError(
      'malformed-response',
      'Expected a paged cancellable-run response.',
    );
  return { items: value.items, nextCursor: value.nextCursor };
}

export function createCancellableRunsClient(
  config: OperatorClientConfig,
): CancellableRunsClient {
  const principalId = config.principalId.trim();
  const adapter = config.adapter.trim();
  if (!principalId || !adapter)
    throw new OperatorClientError(
      'malformed-response',
      'principalId and adapter are required.',
    );
  const baseUrl = config.baseUrl?.trim();
  const normalizedBaseUrl = baseUrl
    ? baseUrl.endsWith('/')
      ? baseUrl
      : `${baseUrl}/`
    : undefined;
  const token = config.token?.trim();
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  const maxAttempts = config.retry?.maxAttempts ?? 3;
  const baseDelayMs = config.retry?.baseDelayMs ?? 100;
  const sleep =
    config.retry?.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  return {
    async list(options = {}, signal) {
      const path = pagePath(options);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImplementation(
            targetUrl(normalizedBaseUrl, path),
            {
              method: 'GET',
              signal,
              headers: {
                accept: 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                'x-factory-floor-principal-id': principalId,
                'x-factory-floor-adapter': adapter,
              },
            },
          );
        } catch (error) {
          if ((error as Error).name === 'AbortError')
            throw new OperatorClientError('aborted', 'Request was cancelled.');
          if (attempt < maxAttempts) {
            await sleep(baseDelayMs * 2 ** (attempt - 1));
            continue;
          }
          throw new OperatorClientError(
            'transport',
            'Unable to reach the control plane.',
          );
        }

        if (
          (response.status === 408 ||
            response.status === 429 ||
            response.status >= 500) &&
          attempt < maxAttempts
        ) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }

        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          throw new OperatorClientError(
            response.ok ? 'malformed-response' : 'http',
            response.ok
              ? 'The control plane returned malformed JSON.'
              : `The control plane returned HTTP ${response.status}.`,
            response.status,
          );
        }
        if (!response.ok)
          throw new OperatorClientError(
            response.status === 404 ? 'not-found' : 'http',
            `The control plane returned HTTP ${response.status}.`,
            response.status,
          );
        return assertPage(normalize(parsed));
      }
      throw new OperatorClientError(
        'transport',
        'Unable to reach the control plane.',
      );
    },
  };
}
