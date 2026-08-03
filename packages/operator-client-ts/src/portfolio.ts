export type PortfolioRecord = Record<string, unknown>;
export type PortfolioList = { items: PortfolioRecord[] };
export type PortfolioRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};
export type PortfolioClientConfig = {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  retry?: PortfolioRetryOptions;
};
export type PortfolioSearchOptions = {
  query?: string;
  repository?: string;
  lifecycle?: string;
  route?: string;
  sourceType?: string;
  limit?: number;
};
export type PortfolioEntityOptions = {
  entityType?: string;
  limit?: number;
};
export type PortfolioNextWorkOptions = {
  route?: string;
  repository?: string;
};
export type PortfolioNextWork = PortfolioRecord & {
  work?: PortfolioRecord | null;
  revision?: string | null;
  reason?: string | null;
};

export type PortfolioClientFailureKind =
  | 'invalid-config'
  | 'transport'
  | 'http'
  | 'malformed-response'
  | 'not-found'
  | 'aborted';

export class PortfolioClientError extends Error {
  constructor(
    readonly kind: PortfolioClientFailureKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PortfolioClientError';
  }
}

export const portfolioReadPaths = {
  status: '/api/status',
  entities: '/api/entities',
  entity: '/api/entity',
  nextWork: '/api/next-work',
  ownerDecisions: '/api/owner-decisions',
  search: '/api/search',
} as const;

export interface PortfolioClient {
  status(signal?: AbortSignal): Promise<PortfolioRecord>;
  entities(
    options?: PortfolioEntityOptions,
    signal?: AbortSignal,
  ): Promise<PortfolioList>;
  entity(entityKey: string, signal?: AbortSignal): Promise<PortfolioRecord>;
  nextWork(
    options?: PortfolioNextWorkOptions,
    signal?: AbortSignal,
  ): Promise<PortfolioNextWork>;
  ownerDecisions(signal?: AbortSignal): Promise<PortfolioList>;
  search(
    options?: PortfolioSearchOptions,
    signal?: AbortSignal,
  ): Promise<PortfolioList>;
}

function record(value: unknown, description: string): PortfolioRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new PortfolioClientError(
      'malformed-response',
      `Expected ${description} to be an object.`,
    );
  return value as PortfolioRecord;
}

function recordArray(value: unknown, description: string): PortfolioRecord[] {
  if (!Array.isArray(value))
    throw new PortfolioClientError(
      'malformed-response',
      `Expected ${description} to be an array.`,
    );
  return value.map((item) => record(item, `${description} item`));
}

function normalizeBaseUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PortfolioClientError(
      'invalid-config',
      'Portfolio Control Plane baseUrl must be a valid http or https URL.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new PortfolioClientError(
      'invalid-config',
      'Portfolio Control Plane baseUrl must use http or https.',
    );
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new PortfolioClientError(
      'invalid-config',
      'Portfolio Control Plane baseUrl must not contain credentials, a query, or a fragment.',
    );
  return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
}

function targetUrl(baseUrl: string | undefined, path: string): string {
  return baseUrl ? new URL(path.replace(/^\//, ''), baseUrl).toString() : path;
}

function withQuery(
  path: string,
  values: Record<string, string | number | null | undefined>,
): string {
  const url = new URL(path, 'http://portfolio.local');
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(value: unknown): boolean {
  return recordLike(value) && value.name === 'AbortError';
}

function recordLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorDetails(value: unknown): { code?: string; message?: string } {
  if (!recordLike(value)) return {};
  const error = value.error;
  if (recordLike(error))
    return {
      code: typeof error.code === 'string' ? error.code : undefined,
      message: typeof error.message === 'string' ? error.message : undefined,
    };
  return {
    message: typeof error === 'string' ? error : undefined,
  };
}

export function createPortfolioClient(
  config: PortfolioClientConfig = {},
): PortfolioClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const token = config.token?.trim();
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  const maxAttempts = positiveInteger(config.retry?.maxAttempts, 3);
  const baseDelayMs = positiveInteger(config.retry?.baseDelayMs, 100);
  const sleep =
    config.retry?.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const request = async (
    path: string,
    signal?: AbortSignal,
  ): Promise<PortfolioRecord> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImplementation(targetUrl(baseUrl, path), {
          method: 'GET',
          signal,
          credentials: 'include',
          headers: {
            accept: 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
      } catch (error) {
        if (isAbortError(error))
          throw new PortfolioClientError('aborted', 'Request was cancelled.');
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new PortfolioClientError(
          'transport',
          'Unable to reach the Portfolio Control Plane.',
        );
      }

      if (transientStatus(response.status) && attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }

      const text = await response.text();
      let parsed: unknown = {};
      if (text)
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new PortfolioClientError(
            'malformed-response',
            'The Portfolio Control Plane returned malformed JSON.',
            response.status,
          );
        }

      if (!response.ok) {
        const details = errorDetails(parsed);
        throw new PortfolioClientError(
          response.status === 404 ? 'not-found' : 'http',
          details.message ??
            `The Portfolio Control Plane returned HTTP ${response.status}.`,
          response.status,
          details.code,
        );
      }
      return record(parsed, 'a Portfolio Control Plane response');
    }
    throw new PortfolioClientError(
      'transport',
      'Unable to reach the Portfolio Control Plane.',
    );
  };

  return {
    status: (signal) => request(portfolioReadPaths.status, signal),
    entities: async (options = {}, signal) => {
      const response = await request(
        withQuery(portfolioReadPaths.entities, {
          entity_type: options.entityType,
          limit: options.limit,
        }),
        signal,
      );
      return { items: recordArray(response.entities, 'entities') };
    },
    entity: async (entityKey, signal) => {
      const response = await request(
        withQuery(portfolioReadPaths.entity, { entity_key: entityKey }),
        signal,
      );
      return record(response.entity, 'portfolio entity');
    },
    nextWork: (options = {}, signal) =>
      request(
        withQuery(portfolioReadPaths.nextWork, {
          route: options.route,
          repository: options.repository,
        }),
        signal,
      ),
    ownerDecisions: async (signal) => {
      const response = await request(portfolioReadPaths.ownerDecisions, signal);
      return { items: recordArray(response.decisions, 'owner decisions') };
    },
    search: async (options = {}, signal) => {
      const response = await request(
        withQuery(portfolioReadPaths.search, {
          query: options.query,
          repository: options.repository,
          lifecycle: options.lifecycle,
          route: options.route,
          source_type: options.sourceType,
          limit: options.limit,
        }),
        signal,
      );
      return { items: recordArray(response.items, 'search results') };
    },
  };
}
