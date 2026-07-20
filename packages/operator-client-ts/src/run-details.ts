import {
  OperatorClientError,
  type OperatorClientOptions,
} from './index.js';

export interface RunApprovalDetail {
  id: string;
  status: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  actionId: string;
  actionType: string;
  risk: string;
  actionStatus: string;
  policyDecisionId: string;
  policyName: string;
  policyVersion: string;
  outcome: string;
  policyReason: string;
}

export interface RunPolicyDecisionDetail {
  id: string;
  policyName: string;
  policyVersion: string;
  evaluatorVersion: string;
  subjectKind: string;
  subjectId: string;
  inputArtifactId: string | null;
  normalizedInputs: unknown;
  outcome: string;
  reason: string;
  modifications: unknown;
  createdAt: string;
  actionId: string;
  actionType: string;
  risk: string;
  actionStatus: string;
}

export interface RunResourceDetail {
  id: string;
  regionId: string;
  executionId: string | null;
  attemptId: string | null;
  externalActionId: string | null;
  resourceType: string;
  quantity: string;
  unit: string;
  attributes: unknown;
  createdAt: string;
}

export interface RunArtifactDerivationDetail {
  id: string;
  artifactId: string;
  sourceArtifactId: string | null;
  executionId: string | null;
  attemptId: string | null;
  derivationType: string;
  createdAt: string;
}

export interface RunProjectionFreshnessDetail {
  id: string;
  projectionName: string;
  streamKey: string;
  lastEventId: string | null;
  lastSequenceNumber: string;
  updatedAt: string;
  stalenessMs: number;
  stale: boolean;
}

export interface RunDetailsPage {
  runId: string;
  limits: { records: number };
  approvals: RunApprovalDetail[];
  policyDecisions: RunPolicyDecisionDetail[];
  resources: RunResourceDetail[];
  derivations: RunArtifactDerivationDetail[];
  projectionFreshness: {
    staleAfterMs: number;
    generatedAt: string;
    items: RunProjectionFreshnessDetail[];
  };
}

export interface RunDetailsRequest {
  limit?: number;
}

export interface RunDetailsClient {
  getRunDetails(runId: string, request?: RunDetailsRequest): Promise<RunDetailsPage>;
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('operator_client_base_url_invalid');
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
    throw new Error('operator_client_https_required');
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()),
      normalizeJson(item),
    ]),
  );
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createRunDetailsClient(options: OperatorClientOptions): RunDetailsClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maximumAttempts = options.retry?.maxAttempts ?? 3;
  const baseDelayMs = options.retry?.baseDelayMs ?? 250;
  const maximumDelayMs = options.retry?.maxDelayMs ?? 5_000;
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1)
    throw new Error('operator_client_retry_attempts_invalid');

  return {
    async getRunDetails(runId, request = {}) {
      const normalizedRunId = runId.trim();
      if (!normalizedRunId) throw new Error('run_id_required');
      const url = new URL(
        `api/v1/operator/runs/${encodeURIComponent(normalizedRunId)}/details`,
        baseUrl,
      );
      if (request.limit !== undefined)
        url.searchParams.set('limit', String(request.limit));

      let lastError: unknown;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
          const response = await fetchImplementation(url, {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'x-factory-floor-principal-id': options.principalId,
              'x-factory-floor-adapter': options.adapter,
              ...(options.token
                ? { authorization: `Bearer ${options.token}` }
                : {}),
            },
            cache: 'no-store',
          });
          const payload = (await response.json().catch(() => null)) as unknown;
          if (response.ok) return normalizeJson(payload) as RunDetailsPage;

          const record =
            payload !== null && typeof payload === 'object' && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : {};
          const error =
            record.error !== null &&
            typeof record.error === 'object' &&
            !Array.isArray(record.error)
              ? (record.error as Record<string, unknown>)
              : {};
          const code =
            typeof error.code === 'string' ? error.code : `http_${response.status}`;
          const message =
            typeof error.message === 'string' ? error.message : code;
          const clientError = new OperatorClientError(
            code,
            message,
            response.status,
            retryable(response.status),
          );
          if (!clientError.retryable || attempt === maximumAttempts)
            throw clientError;
          lastError = clientError;
        } catch (error) {
          if (error instanceof OperatorClientError) {
            if (!error.retryable || attempt === maximumAttempts) throw error;
            lastError = error;
          } else {
            lastError = error;
            if (attempt === maximumAttempts)
              throw new OperatorClientError(
                'network_error',
                'Factory Floor could not be reached.',
                0,
                true,
              );
          }
        }
        await wait(Math.min(maximumDelayMs, baseDelayMs * 2 ** (attempt - 1)));
      }
      throw lastError;
    },
  };
}
