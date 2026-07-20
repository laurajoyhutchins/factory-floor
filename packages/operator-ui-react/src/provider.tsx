import type { OperatorClient } from '@factory-floor/operator-client';
import { createContext, useContext, type ReactNode } from 'react';
import { bindOperatorClient } from './api/client.js';

const OperatorClientContext = createContext<OperatorClient | null>(null);

export function OperatorClientProvider({
  client,
  children,
}: {
  client: OperatorClient;
  children: ReactNode;
}) {
  bindOperatorClient(client);
  return (
    <OperatorClientContext.Provider value={client}>
      {children}
    </OperatorClientContext.Provider>
  );
}

export function useOperatorClient() {
  const client = useContext(OperatorClientContext);
  if (!client) {
    throw new Error('OperatorClientProvider is required.');
  }
  return client;
}
