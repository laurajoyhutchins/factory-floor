import {
  OperatorClientError,
  normalize,
  type OperatorClientConfig,
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
  projectionName: string;
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
    scope: 'control_plane_global';
    staleAfterMs: number;
    generatedAt: string;
    items: RunProjectionFreshnessDetail[];
  };
}

export interface RunDetailsRequest {
  limit?: number;
}

export interface RunDetailsClient {
  getRunDetails(
    runId: string,
    request?: RunDetailsRequest,
  ): Promise<RunDetailsPage>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorDetails(body: unknown): { code?: string; message?: string } {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  return {
    code: typeof body.error.code === 'string' ? body.error.code : undefined,
    message:
      typeof body.error.message === 'string' ? body.error.message : undefined,
  };
}

function assertRunDetails(value: unknown): RunDetailsPage {
  if (!isRecord(value))
    throw new OperatorClientError(
      'malformed-response',
      'Expected run details to be an object.',
    );
  if (
    typeof value.runId !== 'string' ||
    !isRecord(value.limits) ||
    typeof value.limits.records !== 'number' ||
    !Array.isArray(value.approvals) ||
    !Array.isArray(value.policyDecisions) ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.derivations) ||
    !isRecord(value.projectionFreshness) ||
    value.projectionFreshness.scope !== 'control_plane_global' ||
    !Array.isArray(value.projectionFreshness.items)
  )
    throw new OperatorClientError(
      'malformed-response',
      'The run details response is incomplete.',
    );
  return value as unknown as RunDetailsPage;
}

export function createRunDetailsClient(
  config: OperatorClientConfig,
): RunDetailsClient {
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

  return {
    async getRunDetails(runId, request = {}) {
      const normalizedRunId = runId.trim();
      if (!normalizedRunId)
        throw new OperatorClientError(
          'malformed-response',
          'runId is required.',
        );
      const url = new URL(
        `/api/v1/operator/runs/${encodeURIComponent(normalizedRunId)}/details`,
        'http://factory-floor.local',
      );
      if (request.limit !== undefined)
        url.searchParams.set('limit', String(request.limit));
      const path = `${url.pathname}${url.search}`;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImplementation(targetUrl(baseUrl, path), {
            method: 'GET',
            headers: {
              accept: 'application/json',
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              'x-factory-floor-principal-id': principalId,
              'x-factory-floor-adapter': adapter,
            },
            cache: 'no-store',
          });
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

        if (transientStatus(response.status) && attempt < maxAttempts) {
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
        return assertRunDetails(normalize(parsed));
      }

      throw new OperatorClientError(
        'transport',
        'Unable to reach the control plane.',
      );
    },
  };
}
