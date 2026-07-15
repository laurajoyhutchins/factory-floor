import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const digest = 'a'.repeat(64);
const uuid = '018f6f63-7f89-7abc-8def-0123456789ab';
const schemaDir = join(process.cwd(), 'contracts', 'schemas');
const fixturesDir = join(process.cwd(), 'contracts', 'fixtures');

function readFixture(path: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, path), 'utf8'));
}

function validators() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const name of readdirSync(schemaDir).filter((entry) => entry.endsWith('.schema.json')).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, name), 'utf8')));
  }
  return {
    validate: (schema: string, value: unknown) => ajv.getSchema(`https://factory-floor.local/contracts/${schema}.schema.json`)!(value),
  };
}

const source = { kind: 'command', commandId: uuid, submittedBy: 'operator' };
const artifact = {
  artifactId: uuid,
  digest,
  sizeBytes: 12,
  mediaType: 'application/json',
  schemaId: 'example.schema.json',
  schemaDigest: digest,
  uri: 'https://artifacts.local/read/example',
  provenance: source,
};
const stagedArtifact = {
  stagingId: uuid,
  portName: 'result',
  digest,
  sizeBytes: 12,
  mediaType: 'application/json',
  schemaId: 'example.schema.json',
  schemaDigest: digest,
  provenance: source,
};
const resourceUsage = { cpuMilliseconds: 1, wallMilliseconds: 2, inputBytes: 3, outputBytes: 4, externalCalls: 0 };
const failure = { code: 'VERIFY_FAILED', message: 'Verifier rejected the result.', category: 'model', retryable: true };
const externalActionProposal = {
  proposalId: uuid,
  actionType: 'notify.operator',
  idempotencyKey: 'notify-1',
  capabilityHandle: 'cap_123',
  requestArtifact: stagedArtifact,
  risk: 'medium',
};

describe('runtime JSON contracts', () => {
  it.each([
    ['source-identity', source],
    ['artifact-descriptor', artifact],
    ['staged-artifact', stagedArtifact],
    ['failure-descriptor', failure],
    ['external-action-proposal', externalActionProposal],
    ['resource-usage', resourceUsage],
    ['proposed-event', readFixture('proposed-events/valid-event.json')],
  ])('accepts a valid %s contract', (schema, value) => {
    expect(validators().validate(schema, value)).toBe(true);
  });

  it('accepts a valid invocation envelope', () => {
    expect(validators().validate('invocation-envelope', {
      protocolVersion: '1.0',
      executionId: uuid,
      attemptId: uuid,
      attemptNumber: 1,
      leaseToken: 'lease',
      leaseExpiresAt: '2026-07-14T00:00:00.000Z',
      lifecycleEpoch: 0,
      component: { componentId: uuid, definitionId: uuid, definitionName: 'demo', definitionVersion: '1', definition: {}, configuration: {} },
      inputs: [{ portName: 'in', deliveryId: uuid, payload: {}, artifacts: [artifact], artifactReadUrls: ['https://worker.local/artifacts/a'] }],
      state: null,
      capabilityHandles: ['cap_123'],
      cancellationUrl: 'https://worker.local/cancel',
      heartbeatUrl: 'https://worker.local/heartbeat',
      resultSubmissionUrl: 'https://worker.local/results',
      artifactStagingUrl: 'https://worker.local/artifacts/stage',
      capabilityInvocationUrl: 'https://worker.local/capabilities/invoke',
      limits: { heartbeatIntervalMs: 20000, maxArtifactBytes: 104857600 },
      traceContext: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
      source,
    })).toBe(true);
  });

  it('rejects uppercase or short SHA-256 digests', () => {
    expect(validators().validate('artifact-descriptor', { ...artifact, digest: 'A'.repeat(64) })).toBe(false);
    expect(validators().validate('artifact-descriptor', { ...artifact, digest: 'a'.repeat(63) })).toBe(false);
  });

  it('validates shared proposed-result fixtures with Ajv', () => {
    expect(validators().validate('proposed-result', readFixture('proposed-results/valid-completed.json'))).toBe(true);
    expect(validators().validate('proposed-result', readFixture('proposed-results/valid-failed.json'))).toBe(true);
    expect(validators().validate('proposed-result', readFixture('proposed-results/invalid-failed-missing-failure.json'))).toBe(false);
    expect(validators().validate('proposed-result', readFixture('proposed-results/invalid-completed-with-failure.json'))).toBe(false);
  });

  it('uses source identity as a kind-discriminated union', () => {
    expect(validators().validate('source-identity', { kind: 'command', eventId: uuid, submittedBy: 'operator' })).toBe(false);
    expect(validators().validate('source-identity', { kind: 'event', eventId: uuid, producerComponentId: uuid })).toBe(true);
  });

  it('rejects additional properties on protocol envelopes', () => {
    const proposed = {
      ...readFixture('proposed-results/valid-completed.json') as Record<string, unknown>,
      surprise: true,
    };
    expect(validators().validate('proposed-result', proposed)).toBe(false);
  });

  it('rejects malformed proposed events', () => {
    expect(validators().validate('proposed-event', readFixture('proposed-events/invalid-event-missing-subject.json'))).toBe(false);
  });
});
