/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { TemplateInstantiationService } from '../src/systems/durable-template-instantiation-service.js';

const requestA = '019bb22e-58b0-7d87-8000-000000000201';
const requestB = '019bb22e-58b0-7d87-8000-000000000202';

function harness() {
  const transaction = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          execute: async () => [{ id: 'component-verifier', name: 'verifier' }],
        }),
      }),
    }),
  };
  const db = {
    transaction: () => ({
      execute: (callback: (trx: unknown) => unknown) => callback(transaction),
    }),
  } as any;
  const records: any[] = [];
  const artifacts: any[] = [];
  const inlinePayloads: any[] = [];
  const versions: any[] = [];
  const links: any[] = [];
  const topologyResult = {
    disposition: 'created' as const,
    digest: 'c'.repeat(64),
    region: { id: 'region-alpha', name: 'alpha' },
    revision: { id: 'revision-alpha' },
    template: {
      id: 'template-alpha',
      name: 'alpha',
      version: '1',
      contentDigest: 'a'.repeat(64),
    },
    parameters: {},
    source: { kind: 'internal', operation: 'test' },
    referencedDefinitions: [],
  };
  const topologyService = {
    instantiateInTransaction: async () => topologyResult,
  } as any;
  const initialStateResolver = {
    resolve: async () => [
      {
        componentInstanceName: 'verifier',
        portName: 'checkpoint',
        schemaId: 'schema-checkpoint',
        schemaDigest: 'b'.repeat(64),
        value: { completedSteps: [] },
      },
    ],
  } as any;
  const instantiations = {
    findByRequestId: async (_db: unknown, requestId: string) =>
      records.find((record) => record.request_id === requestId),
    create: async (_db: unknown, input: any) => {
      const record = {
        id: `instantiation-${records.length + 1}`,
        request_id: input.requestId,
        request_digest: input.requestDigest,
        target_region_id: input.targetRegionId,
        topology_revision_id: input.topologyRevisionId,
        template_id: input.templateId,
        effective_digest: input.effectiveDigest,
      };
      records.push(record);
      return record;
    },
  } as any;
  const artifactRepository = {
    createCommittedArtifactIdempotently: async (_db: unknown, input: any) => {
      const existing = artifacts.find(
        (artifact) => artifact.digest === input.digest,
      );
      if (existing) return { artifact: existing, created: false };
      const artifact = {
        id: `artifact-${artifacts.length + 1}`,
        digest_algorithm: 'sha256',
        digest: input.digest,
        size_bytes: input.sizeBytes,
        schema_id: input.schemaId,
        media_type: input.mediaType,
        committed_locator: input.locator,
        provenance: input.provenance,
        state: 'committed',
      };
      artifacts.push(artifact);
      return { artifact, created: true };
    },
  } as any;
  const stateRepository = {
    createInlinePayloadIdempotently: async (_db: unknown, input: any) => {
      const existing = inlinePayloads.find(
        (payload) => payload.artifact_id === input.artifactId,
      );
      if (existing) return { payload: existing, created: false };
      const payload = {
        artifact_id: input.artifactId,
        payload: input.payload,
        canonical_size_bytes: input.canonicalSizeBytes,
      };
      inlinePayloads.push(payload);
      return { payload, created: true };
    },
    createInitialVersionIdempotently: async (_db: unknown, input: any) => {
      const existing = versions.find(
        (version) =>
          version.component_instance_id === input.componentInstanceId &&
          version.state_port_name === input.statePortName &&
          version.version_number === 1,
      );
      if (existing) return { version: existing, created: false };
      const version = {
        id: `state-version-${versions.length + 1}`,
        component_instance_id: input.componentInstanceId,
        state_port_name: input.statePortName,
        version_number: 1,
        artifact_id: input.artifactId,
        schema_id: input.schemaId,
        topology_revision_id: input.topologyRevisionId,
        region_id: input.regionId,
        source_template_id: input.sourceTemplateId,
        origin_template_instantiation_id: input.originTemplateInstantiationId,
        provenance: input.provenance,
      };
      versions.push(version);
      return { version, created: true };
    },
    linkInstantiationIdempotently: async (
      _db: unknown,
      instantiationId: string,
      stateVersionId: string,
    ) => {
      if (
        !links.some(
          (link) =>
            link.template_instantiation_id === instantiationId &&
            link.state_version_id === stateVersionId,
        )
      )
        links.push({
          template_instantiation_id: instantiationId,
          state_version_id: stateVersionId,
        });
    },
  } as any;

  return {
    service: new TemplateInstantiationService(
      db,
      {} as any,
      {} as any,
      instantiations,
      artifactRepository,
      stateRepository,
      initialStateResolver,
      topologyService,
    ),
    records,
    artifacts,
    inlinePayloads,
    versions,
    links,
  };
}

function request(requestId = requestA) {
  return {
    requestId,
    targetRegionId: 'region-alpha',
    template: 'alpha@1',
    source: { kind: 'internal', operation: 'test' },
  };
}

describe('template initial state publication', () => {
  it('publishes a content-addressed seed artifact, state version, and instantiation link', async () => {
    const { service, artifacts, inlinePayloads, versions, links } = harness();

    const result = await service.instantiate(request());

    expect(result.instantiationId).toBe('instantiation-1');
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-1',
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        schema_id: 'schema-checkpoint',
        media_type: 'application/json',
        committed_locator: expect.stringMatching(/^inline-json:\/\//),
        provenance: expect.objectContaining({
          kind: 'templateInstantiation',
          instantiationId: 'instantiation-1',
          templateId: 'template-alpha',
          regionId: 'region-alpha',
        }),
      }),
    ]);
    expect(inlinePayloads).toEqual([
      expect.objectContaining({
        artifact_id: 'artifact-1',
        payload: { completedSteps: [] },
      }),
    ]);
    expect(versions).toEqual([
      expect.objectContaining({
        id: 'state-version-1',
        component_instance_id: 'component-verifier',
        state_port_name: 'checkpoint',
        artifact_id: 'artifact-1',
        schema_id: 'schema-checkpoint',
        topology_revision_id: 'revision-alpha',
        source_template_id: 'template-alpha',
      }),
    ]);
    expect(links).toEqual([
      {
        template_instantiation_id: 'instantiation-1',
        state_version_id: 'state-version-1',
      },
    ]);
  });

  it('does not duplicate state artifacts, versions, or links on retry', async () => {
    const { service, artifacts, inlinePayloads, versions, links } = harness();

    await service.instantiate(request());
    const retry = await service.instantiate(request());

    expect(retry).toMatchObject({
      disposition: 'existing',
      instantiationId: 'instantiation-1',
    });
    expect(artifacts).toHaveLength(1);
    expect(inlinePayloads).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(links).toHaveLength(1);
  });

  it('reuses the seed artifact and version while linking a distinct existing request', async () => {
    const { service, records, artifacts, versions, links } = harness();

    await service.instantiate(request(requestA));
    await service.instantiate(request(requestB));

    expect(records).toHaveLength(2);
    expect(artifacts).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(links).toEqual([
      {
        template_instantiation_id: 'instantiation-1',
        state_version_id: 'state-version-1',
      },
      {
        template_instantiation_id: 'instantiation-2',
        state_version_id: 'state-version-1',
      },
    ]);
  });
});
