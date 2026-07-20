import {
  configureDefaultOperatorClient,
  createOperatorClient,
  type OperatorClient,
} from '@factory-floor/operator-client-ts';

export type StandaloneConsoleEnvironment = {
  token?: string;
  baseUrl?: string;
};

export function createStandaloneConsoleClient(
  environment: StandaloneConsoleEnvironment,
  fetchImplementation?: typeof globalThis.fetch,
): OperatorClient {
  return createOperatorClient({
    baseUrl: environment.baseUrl,
    token: environment.token,
    principalId: 'standalone-console',
    adapter: 'standalone-console',
    fetch: fetchImplementation,
  });
}

configureDefaultOperatorClient(
  createStandaloneConsoleClient({
    token: import.meta.env.VITE_FACTORY_FLOOR_OPERATOR_TOKEN?.trim(),
    baseUrl: import.meta.env.VITE_FACTORY_FLOOR_CONTROL_PLANE_URL?.trim(),
  }),
);
