/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { TemplateInitialStateResolver } from '../src/systems/template-initial-state-resolver.js';

function template(initialState: unknown) {
  return {
    id: 'template-id',
    name: 'seeded',
    version: '1',
    content_digest: 'a'.repeat(64),
    retired_at: null,
    template: {
      apiVersion: 'factory-floor.dev/v1alpha1',
      kind: 'Template',
      metadata: { name: 'seeded', version: '1' },
      spec: {
        initialTopology: {
          instances: [
            {
              name: 'verifier',
              component: 'verify@1',
              initialState,
            },
          ],
          connections: [],
        },
      },
    },
  };
}

function harness(options: {
  initialState?: unknown;
  direction?: 'input' | 'output' | 'state';
  schema?: Record<string, unknown>;
} = {}) {
  const definitions = {
    findTemplate: async () =>
      template(
        options.initialState ?? {
          port: 'checkpoint',
          value: {
            completedSteps: { $parameter: 'completedSteps' },
          },
        },
      ),
    findComponentDefinition: async () => ({
      id: 'component-definition-id',
      name: 'verify',
      version: '1',
      content_digest: 'b'.repeat(64),
      retired_at: null,
    }),
    listPorts: async () => [
      {
        id: 'port-id',
        name: 'checkpoint',
        direction: options.direction ?? 'state',
        schema_id: 'schema-id',
        required: false,
      },
    ],
    findArtifactSchemaById: async () => ({
      id: 'schema-id',
      name: 'checkpoint',
      version: '1',
      content_digest: 'c'.repeat(64),
      schema:
        options.schema ??
        ({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          additionalProperties: false,
          required: ['completedSteps'],
          properties: {
            completedSteps: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        } as const),
      retired_at: null,
    }),
  } as any;

  return new TemplateInitialStateResolver(definitions);
}

describe('TemplateInitialStateResolver', () => {
  it('binds parameters and validates the seed against the state port schema', async () => {
    const result = await harness().resolve({} as any, {
      template: 'seeded@1',
      parameters: { completedSteps: ['fetch', 'compare'] },
    });

    expect(result).toEqual([
      {
        componentInstanceName: 'verifier',
        portName: 'checkpoint',
        schemaId: 'schema-id',
        schemaDigest: 'c'.repeat(64),
        value: { completedSteps: ['fetch', 'compare'] },
      },
    ]);
  });

  it('rejects a target that is not an explicit state port', async () => {
    await expect(
      harness({ direction: 'input' }).resolve({} as any, {
        template: 'seeded@1',
        parameters: { completedSteps: [] },
      }),
    ).rejects.toMatchObject({ code: 'invalid_port_reference' });
  });

  it('rejects schema-invalid state before topology publication', async () => {
    await expect(
      harness().resolve({} as any, {
        template: 'seeded@1',
        parameters: { completedSteps: 'not-an-array' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_declaration' });
  });

  it('requires an explicit port and value declaration', async () => {
    await expect(
      harness({ initialState: { port: 'checkpoint' } }).resolve({} as any, {
        template: 'seeded@1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_declaration' });
  });
});
