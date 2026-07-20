import {
  OperatorApiError,
  type InspectionRecord,
  type OperatorClient,
  type Page,
  type PageOptions,
  type TemplateInstantiationScope,
} from '@factory-floor/operator-client';

let currentClient: OperatorClient | undefined;

export function bindOperatorClient(client: OperatorClient) {
  currentClient = client;
}

function client() {
  if (!currentClient) {
    throw new Error('OperatorClientProvider is required.');
  }
  return currentClient;
}

export const consoleApi = {
  health: (...args: Parameters<OperatorClient['health']>) =>
    client().health(...args),
  regions: (...args: Parameters<OperatorClient['regions']>) =>
    client().regions(...args),
  events: (...args: Parameters<OperatorClient['events']>) =>
    client().events(...args),
  deliveries: (...args: Parameters<OperatorClient['deliveries']>) =>
    client().deliveries(...args),
  executions: (...args: Parameters<OperatorClient['executions']>) =>
    client().executions(...args),
  execution: (...args: Parameters<OperatorClient['execution']>) =>
    client().execution(...args),
  executionAttempts: (
    ...args: Parameters<OperatorClient['executionAttempts']>
  ) => client().executionAttempts(...args),
  attempts: (...args: Parameters<OperatorClient['attempts']>) =>
    client().attempts(...args),
  artifacts: (...args: Parameters<OperatorClient['artifacts']>) =>
    client().artifacts(...args),
  artifactLineage: (...args: Parameters<OperatorClient['artifactLineage']>) =>
    client().artifactLineage(...args),
  resources: (...args: Parameters<OperatorClient['resources']>) =>
    client().resources(...args),
  policyDecisions: (...args: Parameters<OperatorClient['policyDecisions']>) =>
    client().policyDecisions(...args),
  projections: (...args: Parameters<OperatorClient['projections']>) =>
    client().projections(...args),
  topology: (...args: Parameters<OperatorClient['topology']>) =>
    client().topology(...args),
  templateInstantiations: (
    ...args: Parameters<OperatorClient['templateInstantiations']>
  ) => client().templateInstantiations(...args),
  templateInstantiation: (
    ...args: Parameters<OperatorClient['templateInstantiation']>
  ) => client().templateInstantiation(...args),
  get streamPath() {
    return client().streamPath;
  },
};

export function inspectionHeaders(accept: string) {
  return client().headers(accept);
}

export { OperatorApiError as ApiError };
export type {
  InspectionRecord,
  OperatorClient,
  Page,
  PageOptions,
  TemplateInstantiationScope,
};
