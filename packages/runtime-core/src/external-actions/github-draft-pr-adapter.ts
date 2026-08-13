import type { Json } from '@factory-floor/db';
import {
  ExternalActionIndeterminateError,
  type ExternalActionProvider,
  type ExternalActionProviderRequest,
  type ExternalActionProviderResult,
} from './external-action-service.js';

export const GITHUB_DRAFT_PULL_REQUEST_ACTION =
  'github.draft_pull_request.upsert';

interface GitHubDraftPullRequestArtifact {
  repository: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

interface GitHubPullRequestSummary {
  number: number;
  draft: boolean;
  html_url: string;
  body?: string | null;
  head?: { ref?: string };
  base?: { ref?: string };
}

export interface GitHubDraftPullRequestAdapterOptions {
  repository: string;
  token: string;
  allowedHeadPrefixes: readonly string[];
  allowedBaseBranches: readonly string[];
  loadRequestArtifact: (artifactId: string) => Promise<unknown>;
  fetch?: typeof fetch;
}

export class GitHubDraftPullRequestAdapter implements ExternalActionProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubDraftPullRequestAdapterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async dispatch(
    request: ExternalActionProviderRequest,
  ): Promise<ExternalActionProviderResult> {
    const prepared = await this.prepare(request);
    if ('failure' in prepared) return prepared.failure;

    const existing = await this.lookup(prepared.artifact, request.idempotencyKey);
    if (existing.status !== 'acknowledged') return existing;
    if (existing.pullRequest)
      return this.acknowledged(
        'existing_draft',
        existing.pullRequest,
        existing.response,
      );

    const marker = this.idempotencyMarker(request.idempotencyKey);
    let providerResponse: Response;
    try {
      providerResponse = await this.fetchImpl(
        `https://api.github.com/repos/${prepared.artifact.repository}/pulls`,
        {
          method: 'POST',
          redirect: 'error',
          headers: this.headers(),
          body: JSON.stringify({
            head: prepared.artifact.head,
            base: prepared.artifact.base,
            title: prepared.artifact.title,
            body: `${marker}\n${prepared.artifact.body}`,
            draft: true,
          }),
        },
      );
    } catch (error) {
      throw new ExternalActionIndeterminateError(
        'GitHub draft pull request dispatch completed with an unknown provider outcome.',
        {
          provider: 'github',
          operation: 'create_draft',
          code: 'github_dispatch_transport_indeterminate',
          retry_classification: 'reconcile_before_retry',
          error_kind: this.errorKind(error),
        },
      );
    }

    const metadata = this.responseMetadata(providerResponse);
    if (!providerResponse.ok)
      return this.providerFailure(
        'create_draft',
        providerResponse.status,
        metadata,
      );

    const payload = await this.readJson(providerResponse);
    const pullRequest = this.pullRequestSummary(payload);
    if (!pullRequest)
      return {
        status: 'indeterminate',
        response: {
          provider: 'github',
          operation: 'create_draft',
          code: 'github_create_response_invalid',
          retry_classification: 'reconcile_before_retry',
          ...metadata,
        },
      };
    return this.acknowledged('created_draft', pullRequest, metadata);
  }

  async reconcile(
    request: ExternalActionProviderRequest,
  ): Promise<ExternalActionProviderResult> {
    const prepared = await this.prepare(request);
    if ('failure' in prepared) return prepared.failure;

    const existing = await this.lookup(prepared.artifact, request.idempotencyKey);
    if (existing.status !== 'acknowledged') return existing;
    if (existing.pullRequest)
      return this.acknowledged(
        'reconciled_draft',
        existing.pullRequest,
        existing.response,
      );
    return {
      status: 'indeterminate',
      response: {
        provider: 'github',
        operation: 'reconcile',
        code: 'github_draft_pull_request_not_found',
        retry_classification: 'reconcile_before_retry',
        ...existing.response,
      },
    };
  }

  private async prepare(request: ExternalActionProviderRequest): Promise<
    | { artifact: GitHubDraftPullRequestArtifact }
    | { failure: ExternalActionProviderResult }
  > {
    if (request.actionType !== GITHUB_DRAFT_PULL_REQUEST_ACTION)
      return { failure: this.scopeFailure('unsupported_action_type') };
    if (!this.validIdempotencyKey(request.idempotencyKey))
      return { failure: this.scopeFailure('invalid_idempotency_key') };

    const raw = await this.options.loadRequestArtifact(
      request.outboundRequestArtifactId,
    );
    const artifact = this.parseArtifact(raw);
    if (!artifact) return { failure: this.scopeFailure('invalid_request_artifact') };
    if (
      artifact.repository !== this.options.repository ||
      !this.options.allowedBaseBranches.includes(artifact.base) ||
      !this.options.allowedHeadPrefixes.some(prefix =>
        artifact.head.startsWith(prefix),
      )
    )
      return { failure: this.scopeFailure('configured_scope_mismatch') };
    return { artifact };
  }

  private async lookup(
    artifact: GitHubDraftPullRequestArtifact,
    idempotencyKey: string,
  ): Promise<
    | {
        status: 'acknowledged';
        pullRequest: GitHubPullRequestSummary | null;
        response: Record<string, Json>;
      }
    | ExternalActionProviderResult
  > {
    const [owner] = artifact.repository.split('/');
    const query = new URLSearchParams({
      state: 'open',
      head: `${owner}:${artifact.head}`,
      base: artifact.base,
      per_page: '100',
    });
    let providerResponse: Response;
    try {
      providerResponse = await this.fetchImpl(
        `https://api.github.com/repos/${artifact.repository}/pulls?${query.toString()}`,
        {
          method: 'GET',
          redirect: 'error',
          headers: this.headers(),
        },
      );
    } catch (error) {
      return {
        status: 'indeterminate',
        response: {
          provider: 'github',
          operation: 'reconcile',
          code: 'github_lookup_transport_indeterminate',
          retry_classification: 'reconcile_before_retry',
          error_kind: this.errorKind(error),
        },
      };
    }

    const metadata = this.responseMetadata(providerResponse);
    if (!providerResponse.ok)
      return this.providerFailure('reconcile', providerResponse.status, metadata);

    const payload = await this.readJson(providerResponse);
    if (!Array.isArray(payload))
      return {
        status: 'indeterminate',
        response: {
          provider: 'github',
          operation: 'reconcile',
          code: 'github_lookup_response_invalid',
          retry_classification: 'reconcile_before_retry',
          ...metadata,
        },
      };

    const marker = this.idempotencyMarker(idempotencyKey);
    const pullRequest = payload
      .map(item => this.pullRequestSummary(item))
      .find(
        item =>
          item !== null &&
          item.draft &&
          item.head?.ref === artifact.head &&
          item.base?.ref === artifact.base &&
          item.body?.includes(marker),
      );
    return {
      status: 'acknowledged',
      pullRequest: pullRequest ?? null,
      response: metadata,
    };
  }

  private acknowledged(
    operation: string,
    pullRequest: GitHubPullRequestSummary,
    metadata: Record<string, Json>,
  ): ExternalActionProviderResult {
    return {
      status: 'acknowledged',
      response: {
        provider: 'github',
        operation,
        pull_request_number: pullRequest.number,
        pull_request_url: pullRequest.html_url,
        ...metadata,
      },
    };
  }

  private providerFailure(
    operation: string,
    status: number,
    metadata: Record<string, Json>,
  ): ExternalActionProviderResult {
    const retryable = status === 408 || status === 429 || status >= 500;
    return {
      status: retryable ? 'indeterminate' : 'failed',
      response: {
        provider: 'github',
        operation,
        code: retryable
          ? 'github_provider_retryable_failure'
          : 'github_provider_terminal_failure',
        http_status: status,
        retry_classification: retryable
          ? 'reconcile_before_retry'
          : 'terminal',
        ...metadata,
      },
    };
  }

  private scopeFailure(reason: string): ExternalActionProviderResult {
    return {
      status: 'failed',
      response: {
        provider: 'github',
        code: 'github_external_action_scope_denied',
        reason,
        retry_classification: 'terminal',
      },
    };
  }

  private responseMetadata(response: Response): Record<string, Json> {
    const metadata: Record<string, Json> = {};
    const requestId = response.headers.get('x-github-request-id');
    if (requestId) metadata.github_request_id = requestId;
    const limit = this.headerNumber(response, 'x-ratelimit-limit');
    const remaining = this.headerNumber(response, 'x-ratelimit-remaining');
    const reset = this.headerNumber(response, 'x-ratelimit-reset');
    if (limit !== null || remaining !== null || reset !== null)
      metadata.rate_limit = {
        ...(limit === null ? {} : { limit }),
        ...(remaining === null ? {} : { remaining }),
        ...(reset === null ? {} : { reset }),
      };
    return metadata;
  }

  private headerNumber(response: Response, name: string): number | null {
    const raw = response.headers.get(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  private headers(): HeadersInit {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.options.token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    };
  }

  private parseArtifact(raw: unknown): GitHubDraftPullRequestArtifact | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const repository = this.boundedString(value.repository, 200);
    const head = this.boundedString(value.head, 255);
    const base = this.boundedString(value.base, 255);
    const title = this.boundedString(value.title, 256);
    const body = this.boundedString(value.body, 65_000, true);
    if (repository === null || head === null || base === null || title === null || body === null)
      return null;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
    if (!this.safeRef(head) || !this.safeRef(base)) return null;
    return { repository, head, base, title, body };
  }

  private pullRequestSummary(raw: unknown): GitHubPullRequestSummary | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(value.number) || Number(value.number) < 1) return null;
    if (typeof value.draft !== 'boolean' || typeof value.html_url !== 'string')
      return null;
    const head = this.refObject(value.head);
    const base = this.refObject(value.base);
    const body = value.body === null || typeof value.body === 'string' ? value.body : undefined;
    return {
      number: Number(value.number),
      draft: value.draft,
      html_url: value.html_url,
      ...(body === undefined ? {} : { body }),
      ...(head ? { head } : {}),
      ...(base ? { base } : {}),
    };
  }

  private refObject(raw: unknown): { ref?: string } | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const ref = (raw as Record<string, unknown>).ref;
    return typeof ref === 'string' ? { ref } : undefined;
  }

  private boundedString(raw: unknown, maxLength: number, allowEmpty = false): string | null {
    if (typeof raw !== 'string' || raw.length > maxLength) return null;
    if (!allowEmpty && raw.trim() === '') return null;
    return raw;
  }

  private safeRef(value: string): boolean {
    return (
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('..') &&
      !value.includes('~') &&
      !value.includes('^') &&
      !value.includes(':') &&
      !value.includes('?') &&
      !value.includes('*') &&
      !value.includes('[') &&
      !value.includes('\\') &&
      !/[\u0000-\u001f\u007f\s]/u.test(value)
    );
  }

  private validIdempotencyKey(value: string): boolean {
    return /^[A-Za-z0-9._:/-]{1,200}$/.test(value);
  }

  private idempotencyMarker(value: string): string {
    return `<!-- factory-floor-idempotency:${value} -->`;
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private errorKind(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }
}
