import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  configureDefaultOperatorClient,
  createOperatorClient,
} from '@factory-floor/operator-client-ts';
import { createRunDetailsClient } from '@factory-floor/operator-client-ts/run-details';
import {
  RunDetailsPanel,
  RunOperatorWorkspace,
} from '@factory-floor/operator-ui-react';
import { useEffect, useRef, useState } from 'react';
import { beginActivityBootstrap } from './bootstrap.js';
import {
  createActivityBroker,
  readActivitySessionContext,
  refreshActivitySession,
  revokeActivitySession,
} from './broker.js';
import type { DiscordActivityConfig } from './config.js';
import type { ActivityHost, ActivitySessionContext } from './contracts.js';
import { createDiscordActivityHost } from './discord-host.js';
import {
  ActivitySessionController,
  type ActivityConnectionState,
} from './session.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
      refetchInterval: 15_000,
    },
  },
});

type AppState =
  | { kind: 'disabled' }
  | { kind: 'starting' }
  | { kind: 'ready'; context: ActivitySessionContext }
  | { kind: 'error'; code: string }
  | { kind: 'expired' };

function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)
    ? error.message
    : 'activity_bootstrap_failed';
}

function clearOperatorState(controlPlaneUrl: string): void {
  configureDefaultOperatorClient(
    createOperatorClient({
      baseUrl: controlPlaneUrl,
      principalId: 'activity-session-ended',
      adapter: 'discord-activity',
      retry: { maxAttempts: 1, baseDelayMs: 250 },
    }),
  );
  queryClient.clear();
}

export function DiscordActivityApp({
  config,
  createHost = createDiscordActivityHost,
}: {
  config: DiscordActivityConfig;
  createHost?: (clientId: string) => ActivityHost;
}) {
  const [state, setState] = useState<AppState>(
    config.enabled ? { kind: 'starting' } : { kind: 'disabled' },
  );
  const [connection, setConnection] =
    useState<ActivityConnectionState>('active');
  const controller = useRef<ActivitySessionController | undefined>(undefined);

  useEffect(() => {
    if (!config.enabled) return;
    let cancelled = false;
    clearOperatorState(config.controlPlaneUrl);
    const host = createHost(config.discordClientId);
    const broker = createActivityBroker(config.brokerUrl);

    void (async () => {
      try {
        const bootstrap = await beginActivityBootstrap({
          host,
          broker,
          redirectUri: config.redirectUri,
        });
        const context = await readActivitySessionContext(
          config.controlPlaneUrl,
          bootstrap.sessionToken,
        );
        if (
          context.instanceId !== host.instanceId ||
          context.instanceBindingId !== bootstrap.instanceBindingId ||
          context.runId !== bootstrap.runId
        )
          throw new Error('activity_session_binding_mismatch');
        if (cancelled) return;

        const configureClient = (sessionToken: string) =>
          configureDefaultOperatorClient(
            createOperatorClient({
              baseUrl: config.controlPlaneUrl,
              token: sessionToken,
              principalId: context.principalId,
              adapter: context.adapter,
              retry: { maxAttempts: 2, baseDelayMs: 250 },
            }),
          );
        configureClient(bootstrap.sessionToken);

        const sessionController = new ActivitySessionController(bootstrap, {
          refresh: (sessionToken) =>
            refreshActivitySession(config.controlPlaneUrl, sessionToken),
          onSession: (session) => {
            configureClient(session.sessionToken);
            void queryClient.invalidateQueries();
          },
          onState: setConnection,
          onExpired: () => {
            clearOperatorState(config.controlPlaneUrl);
            setState({ kind: 'expired' });
          },
        });
        controller.current = sessionController;
        sessionController.start();
        setState({ kind: 'ready', context });
      } catch (error) {
        if (!cancelled) {
          clearOperatorState(config.controlPlaneUrl);
          setState({ kind: 'error', code: errorCode(error) });
        }
      }
    })();

    const reconnect = () => void controller.current?.refreshNow();
    window.addEventListener('online', reconnect);
    return () => {
      cancelled = true;
      window.removeEventListener('online', reconnect);
      controller.current?.stop();
      controller.current = undefined;
      clearOperatorState(config.controlPlaneUrl);
    };
  }, [config, createHost]);

  if (state.kind === 'disabled')
    return (
      <main className="activity-state" role="status">
        <h1>Factory Floor Activity</h1>
        <p>This embedded operator is disabled.</p>
      </main>
    );
  if (state.kind === 'starting')
    return (
      <main className="activity-state" role="status">
        <h1>Connecting to Factory Floor</h1>
        <p>Validating the Discord Activity launch and bound run.</p>
      </main>
    );
  if (state.kind === 'error')
    return (
      <main className="activity-state" role="alert">
        <h1>Activity unavailable</h1>
        <p>{state.code}</p>
        <p>
          Close and relaunch the Activity from its trusted Discord entry point.
        </p>
      </main>
    );
  if (state.kind === 'expired')
    return (
      <main className="activity-state" role="alert">
        <h1>Session expired</h1>
        <p>
          Close and relaunch the Activity to obtain a fresh verified session.
        </p>
      </main>
    );

  const leave = async () => {
    const session = controller.current?.current();
    controller.current?.stop();
    controller.current = undefined;
    clearOperatorState(config.controlPlaneUrl);
    if (session?.sessionToken)
      await revokeActivitySession(
        config.controlPlaneUrl,
        session.sessionToken,
      ).catch(() => undefined);
    setState({ kind: 'expired' });
  };

  const loadDetails = (runId: string) => {
    const sessionToken = controller.current?.current().sessionToken;
    if (!sessionToken)
      return Promise.reject(new Error('activity_session_invalid'));
    return createRunDetailsClient({
      baseUrl: config.controlPlaneUrl,
      token: sessionToken,
      principalId: state.context.principalId,
      adapter: state.context.adapter,
      retry: { maxAttempts: 2, baseDelayMs: 250 },
    }).getRunDetails(runId);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <div className="activity-shell">
        <header className="activity-header">
          <div>
            <p className="eyebrow">Discord Activity · Read only</p>
            <h1>Factory Floor run</h1>
            <p className="muted">{state.context.runId}</p>
          </div>
          <div className="activity-actions">
            <span className="badge status" data-status={connection}>
              {connection}
            </span>
            <button type="button" onClick={() => void leave()}>
              End session
            </button>
          </div>
        </header>
        <main>
          <RunOperatorWorkspace runId={state.context.runId} />
          <RunDetailsPanel
            runId={state.context.runId}
            loadDetails={loadDetails}
          />
        </main>
      </div>
    </QueryClientProvider>
  );
}
