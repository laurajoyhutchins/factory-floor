import { isAbsolute, resolve } from 'node:path';
import {
  workerAuthorizationFromEnv,
  type WorkerAuthorization,
} from './routes/worker.js';
import {
  controlPlaneSecurityFromEnv,
  type ControlPlaneSecurity,
} from './security.js';
import { serviceAuthFromEnv, type ServiceAuthKeys } from './service-auth.js';

export interface ProductionControlPlaneConfig {
  databaseUrl: string;
  artifactStoreRoot: string;
  publicUrl: string;
  listener: {
    host: string;
    port: number;
  };
  security: ControlPlaneSecurity;
  workerAuthorization: WorkerAuthorization;
  serviceAuthKeys?: ServiceAuthKeys;
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function listenerPort(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('PORT must be an integer from 1 through 65535');
  return port;
}

function publicUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      'FACTORY_FLOOR_CONTROL_PLANE_URL must be a valid http or https URL',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error(
      'FACTORY_FLOOR_CONTROL_PLANE_URL must be a valid http or https URL',
    );
  if (parsed.username || parsed.password)
    throw new Error(
      'FACTORY_FLOOR_CONTROL_PLANE_URL must not contain credentials',
    );
  return parsed.href.endsWith('/') ? parsed.href.slice(0, -1) : parsed.href;
}

function serviceAuthKeys(
  env: Record<string, string | undefined>,
): ServiceAuthKeys | undefined {
  const agentToFactory = env.FACTORY_FLOOR_AGENT_TO_FACTORY_KEY?.trim();
  const factoryToAgent = env.FACTORY_FLOOR_FACTORY_TO_AGENT_KEY?.trim();
  if (Boolean(agentToFactory) !== Boolean(factoryToAgent))
    throw new Error(
      'FACTORY_FLOOR_AGENT_TO_FACTORY_KEY and FACTORY_FLOOR_FACTORY_TO_AGENT_KEY must be configured together',
    );
  const previousAgent = env.FACTORY_FLOOR_PREVIOUS_AGENT_TO_FACTORY_KEY?.trim();
  const previousFactory =
    env.FACTORY_FLOOR_PREVIOUS_FACTORY_TO_AGENT_KEY?.trim();
  if (
    (previousAgent || previousFactory) &&
    (!agentToFactory || !factoryToAgent)
  )
    throw new Error(
      'previous service-auth keys require current service-auth keys',
    );
  return serviceAuthFromEnv(env);
}

export function loadProductionConfig(
  env: Record<string, string | undefined>,
): ProductionControlPlaneConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const configuredArtifactRoot = required(env, 'ARTIFACT_STORE_ROOT');
  if (!isAbsolute(configuredArtifactRoot))
    throw new Error('ARTIFACT_STORE_ROOT must be an absolute path');
  const host = required(env, 'HOST');
  const publicUrlValue = required(env, 'FACTORY_FLOOR_CONTROL_PLANE_URL');
  const authKeys = serviceAuthKeys(env);

  return {
    databaseUrl,
    artifactStoreRoot: resolve(configuredArtifactRoot),
    publicUrl: publicUrl(publicUrlValue),
    listener: { host, port: listenerPort(env.PORT) },
    security: controlPlaneSecurityFromEnv(env),
    workerAuthorization: workerAuthorizationFromEnv(env),
    ...(authKeys ? { serviceAuthKeys: authKeys } : {}),
  };
}
