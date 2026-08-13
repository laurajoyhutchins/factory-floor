import { describe, expect, it, vi } from 'vitest';
import {
  GitHubDraftPullRequestAdapter,
  GITHUB_DRAFT_PULL_REQUEST_ACTION,
} from './github-draft-pr-adapter.js';

const requestArtifact = {
  repository: 'acme/widgets',
  head: 'agent/task-123',
  base: 'main',
  title: 'Draft generated change',
  body: 'Prepared and verified by Factory Floor.',
};

function providerRequest() {
  return {
    actionId: '018f0000-0000-7000-8000-000000000001',
    actionType: GITHUB_DRAFT_PULL_REQUEST_ACTION,
    idempotencyKey: 'external-action:task-123',
    capabilityGrantId: '018f0000-0000-7000-8000-000000000002',
    outboundRequestArtifactId: '018f0000-0000-7000-8000-000000000003',
  };
}

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': 'REQ-123',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

function adapter(fetchImpl: typeof fetch) {
  return new GitHubDraftPullRequestAdapter({
    repository: 'acme/widgets',
    token: 'server-secret',
    allowedHeadPrefixes: ['agent/'],
    allowedBaseBranches: ['main'],
    loadRequestArtifact: async () => requestArtifact,
    fetch: fetchImpl,
  });
}

describe('GitHubDraftPullRequestAdapter', () => {
  it('reuses an existing idempotency-marked draft instead of creating a duplicate', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        {
          number: 42,
          draft: true,
          html_url: 'https://github.com/acme/widgets/pull/42',
          head: { ref: 'agent/task-123' },
          base: { ref: 'main' },
          body: '<!-- factory-floor-idempotency:external-action:task-123 -->\nPrepared.',
        },
      ]),
    );

    const result = await adapter(fetchImpl).dispatch(providerRequest());

    expect(result.status).toBe('acknowledged');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toContain('/repos/acme/widgets/pulls?');
    expect(result.response).toMatchObject({
      provider: 'github',
      operation: 'existing_draft',
      pull_request_number: 42,
      github_request_id: 'REQ-123',
      rate_limit: { limit: 5000, remaining: 4999 },
    });
  });

  it('creates one scoped draft PR with a durable provider-visible idempotency marker', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(
        response(
          {
            number: 43,
            draft: true,
            html_url: 'https://github.com/acme/widgets/pull/43',
          },
          { status: 201 },
        ),
      );

    const result = await adapter(fetchImpl).dispatch(providerRequest());

    expect(result.status).toBe('acknowledged');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[1] ?? [];
    expect(url?.toString()).toBe('https://api.github.com/repos/acme/widgets/pulls');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer server-secret');
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      head: 'agent/task-123',
      base: 'main',
      title: 'Draft generated change',
      draft: true,
    });
    expect(payload.body).toContain(
      '<!-- factory-floor-idempotency:external-action:task-123 -->',
    );
  });

  it('reconciles by lookup only and stays indeterminate when no matching draft exists', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([]));

    const result = await adapter(fetchImpl).reconcile(providerRequest());

    expect(result).toMatchObject({
      status: 'indeterminate',
      response: {
        provider: 'github',
        operation: 'reconcile',
        code: 'github_draft_pull_request_not_found',
        github_request_id: 'REQ-123',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('fails closed before network I/O when the request escapes configured repository or branch scope', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const scoped = new GitHubDraftPullRequestAdapter({
      repository: 'acme/widgets',
      token: 'server-secret',
      allowedHeadPrefixes: ['agent/'],
      allowedBaseBranches: ['main'],
      loadRequestArtifact: async () => ({
        ...requestArtifact,
        repository: 'other/repository',
        head: 'release/prod',
      }),
      fetch: fetchImpl,
    });

    const result = await scoped.dispatch(providerRequest());

    expect(result).toMatchObject({
      status: 'failed',
      response: {
        provider: 'github',
        code: 'github_external_action_scope_denied',
        retry_classification: 'terminal',
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
