import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../src/declarations/errors.js';
import { TemplateInstantiationContractService } from '../src/systems/template-instantiation-contract-service.js';
import {
  normalizeTemplateInstantiationRequest,
  templateInstantiationRequestSchema,
  toTemplateInstantiationResult,
} from '../src/systems/template-instantiation-contract.js';
import {
  templateInstantiationErrorCodes,
  toTemplateInstantiationError,
} from '../src/systems/template-instantiation-error.js';

const requestId = '019bb22e-58b0-7d87-8000-000000000001';
const instantiationId = '019bb22e-58b0-7d87-8000-000000000009';
const targetRegionId = '019bb22e-58b0-7d87-8000-000000000002';
const revisionId = '019bb22e-58b0-7d87-8000-000000000003';
const templateId = '019bb22e-58b0-7d87-8000-000000000004';
const definitionId = '019bb22e-58b0-7d87-8000-000000000005';
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

const canonicalRequest = {
  protocolVersion: '1.0' as const,
  requestId,
  targetRegionId,
  template: {
    name: 'bounded-investigation',
    version: '1',
  },
  parameters: { mode: 'strict' },
  componentConfiguration: { verifier: { retries: 2 } },
  source: {
    kind: 'system' as const,
    name: 'investigation-demo',
    version: '1',
    contentDigest: digestB,
  },
};

const runtimeResult = {
  disposition: 'created' as const,
  instantiationId,
  digest: digestB,
  region: { id: targetRegionId, name: 'analysis' },
  revision: { id: revisionId, content_digest: digestB },
  template: {
    id: templateId,
    name: 'bounded-investigation',
    version: '1',
    contentDigest: digestA,
  },
  parameters: { mode: 'strict' },
  source: canonicalRequest.source,
  referencedDefinitions: [
    {
      kind: 'component' as const,
      id: definitionId,
      name: 'retrieve',
      version: '1',
      contentDigest: digestA,
    },
  ],
};

const contractResult = {
  protocolVersion: '1.0',
  requestId,
  instantiationId,
  disposition: 'created',
  digest: digestB,
  regionId: targetRegionId,
  topologyRevisionId: revisionId,
  template: runtimeResult.template,
  parameters: { mode: 'strict' },
  source: canonicalRequest.source,
  referencedDefinitions: runtimeResult.referencedDefinitions,
};

const loadSchema = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../contracts/schemas/${name}.schema.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );

describe('template instantiation contract adapter', () => {
  it('uses the exact canonical request schema', () => {
    expect(templateInstantiationRequestSchema).toEqual(
      loadSchema('template-instantiation-request'),
    );
  });

  it('keeps stable error codes synchronized with the canonical schema', () => {
    expect(templateInstantiationErrorCodes).toEqual(
      loadSchema('template-instantiation-error').properties.code.enum,
    );
  });

  it('accepts a canonical request without changing its identity or source', () => {
    expect(normalizeTemplateInstantiationRequest(canonicalRequest)).toEqual({
      protocolVersion: '1.0',
      requestId,
      targetRegionId,
      template: 'bounded-investigation@1',
      parameters: { mode: 'strict' },
      componentConfiguration: { verifier: { retries: 2 } },
      source: canonicalRequest.source,
    });
  });

  it('normalizes an existing in-process request with a deterministic internal source', () => {
    const first = normalizeTemplateInstantiationRequest({
      targetRegionId: 'region-alpha',
      template: 'alpha@1',
      parameters: { mode: 'fast' },
    });
    const second = normalizeTemplateInstantiationRequest({
      targetRegionId: 'region-alpha',
      template: 'alpha@1',
      parameters: { mode: 'fast' },
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      protocolVersion: '1.0',
      targetRegionId: 'region-alpha',
      template: 'alpha@1',
      parameters: { mode: 'fast' },
      componentConfiguration: {},
      source: {
        kind: 'internal',
        operation: 'template-instantiation',
      },
    });
    expect(first.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('rejects malformed canonical input before invoking the database-backed runtime', async () => {
    const instantiate = vi.fn();
    const service = new TemplateInstantiationContractService({ instantiate });

    await expect(
      service.instantiate({
        ...canonicalRequest,
        requestId: 'not-a-uuid',
        unexpected: true,
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_declaration' });
    expect(instantiate).not.toHaveBeenCalled();
  });

  it('invokes the authoritative runtime with caller identity preserved', async () => {
    const instantiate = vi.fn().mockResolvedValue(runtimeResult);
    const service = new TemplateInstantiationContractService({ instantiate });

    await expect(service.instantiate(canonicalRequest)).resolves.toEqual(
      contractResult,
    );
    expect(instantiate).toHaveBeenCalledWith({
      requestId,
      targetRegionId,
      template: 'bounded-investigation@1',
      parameters: { mode: 'strict' },
      componentConfiguration: { verifier: { retries: 2 } },
      source: canonicalRequest.source,
    });
  });

  it('converts implementation rows into the stable canonical result', () => {
    expect(
      toTemplateInstantiationResult({
        request: canonicalRequest,
        ...runtimeResult,
      }),
    ).toEqual(contractResult);
  });

  it('maps stable domain failures without leaking internal failures', () => {
    expect(
      toTemplateInstantiationError(
        new DomainError('region_not_eligible', 'region is already active'),
      ),
    ).toEqual({
      protocolVersion: '1.0',
      code: 'region_not_eligible',
      message: 'region is already active',
      retryable: false,
    });
    expect(
      toTemplateInstantiationError(new Error('database password')),
    ).toEqual({
      protocolVersion: '1.0',
      code: 'internal_transient_failure',
      message: 'template instantiation failed',
      retryable: true,
    });
  });
});
