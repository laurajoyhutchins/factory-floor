import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const loadSchema = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../contracts/schemas/${name}.schema.json`, import.meta.url),
      'utf8',
    ),
  );

const requestSchema = loadSchema('template-instantiation-request');
const resultSchema = loadSchema('template-instantiation-result');
const errorSchema = loadSchema('template-instantiation-error');

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const schema of [requestSchema, resultSchema, errorSchema]) {
  ajv.addSchema(schema);
}

const validateRequest = ajv.getSchema(requestSchema.$id);
const validateResult = ajv.getSchema(resultSchema.$id);
const validateError = ajv.getSchema(errorSchema.$id);

const requestId = '019bb22e-58b0-7d87-8000-000000000001';
const targetRegionId = '019bb22e-58b0-7d87-8000-000000000002';
const revisionId = '019bb22e-58b0-7d87-8000-000000000003';
const templateId = '019bb22e-58b0-7d87-8000-000000000004';
const definitionId = '019bb22e-58b0-7d87-8000-000000000005';
const parentRegionId = '019bb22e-58b0-7d87-8000-000000000006';
const requesterComponentInstanceId = '019bb22e-58b0-7d87-8000-000000000007';
const regionRequestId = '019bb22e-58b0-7d87-8000-000000000008';
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const digestC = 'c'.repeat(64);

const systemRequest = {
  protocolVersion: '1.0',
  requestId,
  targetRegionId,
  template: { name: 'bounded-investigation', version: '1' },
  parameters: { mode: 'strict' },
  componentConfiguration: { verifier: { retries: 2 } },
  source: {
    kind: 'system',
    name: 'investigation-demo',
    version: '1',
    contentDigest: digestA,
  },
};

const regionRequest = {
  ...systemRequest,
  source: {
    kind: 'regionRequest',
    requestId: regionRequestId,
    parentRegionId,
    requesterComponentInstanceId,
  },
};

const createdResult = {
  protocolVersion: '1.0',
  requestId,
  disposition: 'created',
  digest: digestB,
  regionId: targetRegionId,
  topologyRevisionId: revisionId,
  template: {
    id: templateId,
    name: 'bounded-investigation',
    version: '1',
    contentDigest: digestA,
  },
  parameters: { mode: 'strict' },
  source: systemRequest.source,
  referencedDefinitions: [
    {
      kind: 'component',
      id: definitionId,
      name: 'retrieve',
      version: '1',
      contentDigest: digestC,
    },
  ],
};

const existingResult = {
  ...createdResult,
  disposition: 'existing',
};

const conflictError = {
  protocolVersion: '1.0',
  code: 'template_instantiation_conflict',
  message: 'target region already has a different active topology',
  retryable: false,
};

describe('template instantiation contracts', () => {
  it('accepts canonical system and region-request sources', () => {
    expect(validateRequest?.(systemRequest), validateRequest?.errors).toBe(
      true,
    );
    expect(validateRequest?.(regionRequest), validateRequest?.errors).toBe(
      true,
    );
  });

  it('accepts created/existing results and stable errors', () => {
    expect(validateResult?.(createdResult), validateResult?.errors).toBe(true);
    expect(validateResult?.(existingResult), validateResult?.errors).toBe(true);
    expect(validateError?.(conflictError), validateError?.errors).toBe(true);
  });

  it.each([
    ['extra property', { ...systemRequest, unexpected: true }],
    [
      'invalid digest',
      {
        ...systemRequest,
        source: { ...systemRequest.source, contentDigest: 'not-a-digest' },
      },
    ],
    [
      'missing source',
      Object.fromEntries(
        Object.entries(systemRequest).filter(([key]) => key !== 'source'),
      ),
    ],
    ['malformed UUID', { ...systemRequest, requestId: 'request-1' }],
    [
      'unknown source kind',
      { ...systemRequest, source: { kind: 'ambient', id: 'anything' } },
    ],
  ])('rejects a request with %s', (_name, request) => {
    expect(validateRequest?.(request)).toBe(false);
  });

  it('rejects unknown error codes', () => {
    expect(
      validateError?.({ ...conflictError, code: 'database_unique_violation' }),
    ).toBe(false);
  });
});
