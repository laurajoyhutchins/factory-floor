import type {
  ActivityBootstrapResponse,
  ActivityBroker,
  ActivityOAuthStartResponse,
  ActivitySessionContext,
  ActivitySessionCredentials,
} from './contracts.js';

function base(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('activity_endpoint_required');
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function postJson<T>(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetchImplementation(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const record = isRecord(payload) ? payload : {};
    const error = isRecord(record.error) ? record.error : {};
    const code =
      typeof error.code === 'string' ? error.code : `http_${response.status}`;
    throw new Error(code);
  }
  return payload as T;
}

async function authorizedJson<T>(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  sessionToken: string,
  method: 'GET' | 'POST',
): Promise<T> {
  const response = await fetchImplementation(url, {
    method,
    headers: { authorization: `Bearer ${sessionToken}` },
    cache: 'no-store',
  });
  const payload =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const record = isRecord(payload) ? payload : {};
    const error = isRecord(record.error) ? record.error : {};
    const code =
      typeof error.code === 'string' ? error.code : `http_${response.status}`;
    throw new Error(code);
  }
  return payload as T;
}

export function createActivityBroker(
  brokerUrl: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): ActivityBroker {
  const origin = base(brokerUrl);
  return {
    startOAuth: (request) =>
      postJson<ActivityOAuthStartResponse>(
        fetchImplementation,
        new URL('api/v1/discord/activity/oauth/start', origin).toString(),
        request,
      ),
    bootstrap: (request) =>
      postJson<ActivityBootstrapResponse>(
        fetchImplementation,
        new URL('api/v1/discord/activity/bootstrap', origin).toString(),
        request,
      ),
  };
}

export function readActivitySessionContext(
  controlPlaneUrl: string,
  sessionToken: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<ActivitySessionContext> {
  return authorizedJson<ActivitySessionContext>(
    fetchImplementation,
    new URL(
      'api/v1/discord/activity/session',
      base(controlPlaneUrl),
    ).toString(),
    sessionToken,
    'GET',
  );
}

export function refreshActivitySession(
  controlPlaneUrl: string,
  sessionToken: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<ActivitySessionCredentials> {
  return authorizedJson<ActivitySessionCredentials>(
    fetchImplementation,
    new URL(
      'api/v1/discord/activity/session/refresh',
      base(controlPlaneUrl),
    ).toString(),
    sessionToken,
    'POST',
  );
}

export async function revokeActivitySession(
  controlPlaneUrl: string,
  sessionToken: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  await authorizedJson<null>(
    fetchImplementation,
    new URL(
      'api/v1/discord/activity/session/revoke',
      base(controlPlaneUrl),
    ).toString(),
    sessionToken,
    'POST',
  );
}
