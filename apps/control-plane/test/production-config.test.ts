import { describe, expect, it } from 'vitest';
import { loadProductionConfig } from '../src/production-config.js';

const validEnv = {
  DATABASE_URL:
    'postgres://factory_floor:secret@db.internal:5432/factory_floor',
  ARTIFACT_STORE_ROOT: '/var/lib/factory-floor/artifacts',
  FACTORY_FLOOR_CONTROL_PLANE_URL: 'https://factory.example.test',
  HOST: '0.0.0.0',
  PORT: '3000',
  CONTROL_PLANE_OPERATOR_TOKEN: 'operator-secret',
  CONTROL_PLANE_ADMIN_TOKEN: 'admin-secret',
  WORKER_AUTHORIZATION_JSON: JSON.stringify({
    'demo-ts-worker': {
      token: 'ts-secret',
      componentSelectors: ['retrieve@1', 'compare@1', 'synthesize@1'],
    },
    'demo-py-worker': {
      token: 'py-secret',
      componentSelectors: ['verify@1'],
    },
  }),
};

describe('production control-plane configuration', () => {
  it('normalizes one complete fail-closed production configuration', () => {
    expect(loadProductionConfig(validEnv)).toMatchObject({
      databaseUrl: validEnv.DATABASE_URL,
      artifactStoreRoot: validEnv.ARTIFACT_STORE_ROOT,
      publicUrl: 'https://factory.example.test',
      listener: { host: '0.0.0.0', port: 3000 },
      security: {
        operatorToken: 'operator-secret',
        adminToken: 'admin-secret',
      },
      workerAuthorization: {
        workers: {
          'demo-ts-worker': {
            token: 'ts-secret',
            componentSelectors: ['retrieve@1', 'compare@1', 'synthesize@1'],
          },
          'demo-py-worker': {
            token: 'py-secret',
            componentSelectors: ['verify@1'],
          },
        },
      },
    });
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: undefined }, 'DATABASE_URL is required'],
    [
      'ARTIFACT_STORE_ROOT',
      { ARTIFACT_STORE_ROOT: 'relative/path' },
      'ARTIFACT_STORE_ROOT must be an absolute path',
    ],
    [
      'public URL',
      { FACTORY_FLOOR_CONTROL_PLANE_URL: 'not-a-url' },
      'FACTORY_FLOOR_CONTROL_PLANE_URL must be a valid http or https URL',
    ],
    ['port', { PORT: '70000' }, 'PORT must be an integer from 1 through 65535'],
    ['host', { HOST: '   ' }, 'HOST is required'],
  ])('rejects invalid %s before startup', (_name, patch, message) => {
    expect(() => loadProductionConfig({ ...validEnv, ...patch })).toThrow(
      message,
    );
  });

  it('rejects partial service-auth key configuration', () => {
    expect(() =>
      loadProductionConfig({
        ...validEnv,
        FACTORY_FLOOR_AGENT_TO_FACTORY_KEY: 'agent-to-factory',
      }),
    ).toThrow(
      'FACTORY_FLOOR_AGENT_TO_FACTORY_KEY and FACTORY_FLOOR_FACTORY_TO_AGENT_KEY must be configured together',
    );
  });

  it('accepts complete service-auth key configuration', () => {
    expect(
      loadProductionConfig({
        ...validEnv,
        FACTORY_FLOOR_AGENT_TO_FACTORY_KEY: 'agent-to-factory',
        FACTORY_FLOOR_FACTORY_TO_AGENT_KEY: 'factory-to-agent',
      }).serviceAuthKeys,
    ).toEqual({
      agentToFactoryKey: 'agent-to-factory',
      factoryToAgentKey: 'factory-to-agent',
    });
  });
});
