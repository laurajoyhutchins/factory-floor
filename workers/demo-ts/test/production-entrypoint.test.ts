import { describe, expect, it } from 'vitest';
import {
  WorkerProtocolClient,
  type WorkerRunner,
} from '@factory-floor/worker-sdk-ts';
import {
  createShutdownFencedClient,
  loadDemoWorkerConfig,
  startDemoWorkerFromEnv,
} from '../src/index.js';

const validEnv = {
  FACTORY_FLOOR_WORKER_BASE_URL: 'http://127.0.0.1:3000',
  FACTORY_FLOOR_WORKER_TOKEN: 'worker-secret',
  FACTORY_FLOOR_WORKER_ID: 'demo-ts-worker',
  FACTORY_FLOOR_WORKER_CONCURRENCY: '2',
};

describe('TypeScript demo worker production entrypoint', () => {
  it('loads one complete fail-closed worker configuration', () => {
    expect(loadDemoWorkerConfig(validEnv)).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'worker-secret',
      workerId: 'demo-ts-worker',
      concurrency: 2,
    });
  });

  it.each([
    [
      'base URL',
      { FACTORY_FLOOR_WORKER_BASE_URL: 'not-a-url' },
      'FACTORY_FLOOR_WORKER_BASE_URL must be a valid http or https URL',
    ],
    [
      'token',
      { FACTORY_FLOOR_WORKER_TOKEN: ' ' },
      'FACTORY_FLOOR_WORKER_TOKEN is required',
    ],
    [
      'worker id',
      { FACTORY_FLOOR_WORKER_ID: undefined },
      'FACTORY_FLOOR_WORKER_ID is required',
    ],
    [
      'concurrency',
      { FACTORY_FLOOR_WORKER_CONCURRENCY: '0' },
      'FACTORY_FLOOR_WORKER_CONCURRENCY must be a positive integer',
    ],
  ])('rejects invalid %s before startup', (_name, patch, message) => {
    expect(() => loadDemoWorkerConfig({ ...validEnv, ...patch })).toThrow(
      message,
    );
  });

  it('does not issue a network claim after shutdown begins', async () => {
    let stopping = false;
    let networkClaims = 0;
    const rawClient = {
      claim: async () => {
        networkClaims += 1;
        return {
          protocolVersion: '1.0' as const,
          claimed: false as const,
          retryAfterMs: 100,
        };
      },
    } as unknown as WorkerProtocolClient;
    const client = createShutdownFencedClient(rawClient, () => stopping);

    await client.claim(['retrieve@1']);
    stopping = true;
    await expect(client.claim(['retrieve@1'])).resolves.toEqual({
      protocolVersion: '1.0',
      claimed: false,
      retryAfterMs: 0,
    });

    expect(networkClaims).toBe(1);
  });

  it('sets the claim fence before stopping the runner on SIGTERM', async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    let stopped = false;
    let runReleased: (() => void) | undefined;
    let workerClient: WorkerProtocolClient | undefined;
    let networkClaims = 0;
    const runner = {
      run: () =>
        new Promise<void>((resolve) => {
          runReleased = resolve;
        }),
      stop: () => {
        stopped = true;
        runReleased?.();
      },
    } as unknown as WorkerRunner;

    const process = startDemoWorkerFromEnv({
      env: validEnv,
      signalSource: {
        once: (signal, listener) => listeners.set(signal, listener),
        off: (signal) => listeners.delete(signal),
      },
      createClient: () =>
        ({
          claim: async () => {
            networkClaims += 1;
            return {
              protocolVersion: '1.0',
              claimed: false,
              retryAfterMs: 100,
            };
          },
        }) as unknown as WorkerProtocolClient,
      createRunner: ({ client }) => {
        workerClient = client;
        return runner;
      },
    });

    listeners.get('SIGTERM')?.();
    await process;

    expect(stopped).toBe(true);
    if (!workerClient) throw new Error('worker client was not created');
    await workerClient.claim(['retrieve@1']);
    expect(networkClaims).toBe(0);
    expect(listeners.size).toBe(0);
  });
});
