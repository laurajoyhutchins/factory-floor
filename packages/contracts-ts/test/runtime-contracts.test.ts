import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const digest = 'a'.repeat(64);
const uuid = '018f6f63-7f89-7abc-8def-0123456789ab';
const schemaDir = join(process.cwd(), 'contracts', 'schemas');

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
  ])('accepts a valid %s contract', (schema, value) => {
    expect(validators().validate(schema, value)).toBe(true);
  });

  it('accepts a valid invocation envelope', () => {
    expect(validators().validate('invocation-envelope', {
      protocolVersion: '1.0',
      executionId: uuid,
      attemptId: uuid,
      leaseToken: 'lease',
      leaseExpiresAt: '2026-07-14T00:00:00.000Z',
      lifecycleEpoch: 0,
      component: { componentId: uuid, definitionId: 'demo.worker', configuration: {} },
      inputs: [artifact],
      state: null,
      capabilityHandles: ['cap_123'],
      cancellationUrl: 'https://worker.local/cancel',
      heartbeatUrl: 'https://worker.local/heartbeat',
      traceContext: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
      source,
    })).toBe(true);
  });

  it('rejects uppercase or short SHA-256 digests', () => {
    expect(validators().validate('artifact-descriptor', { ...artifact, digest: 'A'.repeat(64) })).toBe(false);
    expect(validators().validate('artifact-descriptor', { ...artifact, digest: 'a'.repeat(63) })).toBe(false);
  });

  it('requires failure details when a proposed result failed', () => {
    const proposed = {
      protocolVersion: '1.0', executionId: uuid, attemptId: uuid, leaseToken: 'lease', lifecycleEpoch: 0,
      status: 'failed', stagedArtifacts: [stagedArtifact], proposedEvents: [], externalActionProposals: [], resourceUsage,
    };
    expect(validators().validate('proposed-result', proposed)).toBe(false);
    expect(validators().validate('proposed-result', { ...proposed, failure })).toBe(true);
  });

  it('uses source identity as a kind-discriminated union', () => {
    expect(validators().validate('source-identity', { kind: 'command', eventId: uuid, submittedBy: 'operator' })).toBe(false);
    expect(validators().validate('source-identity', { kind: 'event', eventId: uuid, producerComponentId: uuid })).toBe(true);
  });

  it('rejects additional properties on protocol envelopes', () => {
    const proposed = {
      protocolVersion: '1.0', executionId: uuid, attemptId: uuid, leaseToken: 'lease', lifecycleEpoch: 0,
      status: 'completed', stagedArtifacts: [], proposedEvents: [], externalActionProposals: [], resourceUsage, surprise: true,
    };
    expect(validators().validate('proposed-result', proposed)).toBe(false);
  });
});
