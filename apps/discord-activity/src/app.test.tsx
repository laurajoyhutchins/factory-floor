import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordActivityApp } from './app.js';
import type { DiscordActivityConfig } from './config.js';

const mocks = vi.hoisted(() => ({
  beginActivityBootstrap: vi.fn(),
  createActivityBroker: vi.fn(),
  readActivitySessionContext: vi.fn(),
  refreshActivitySession: vi.fn(),
  revokeActivitySession: vi.fn(),
  createOperatorClient: vi.fn(),
  configureDefaultOperatorClient: vi.fn(),
}));

vi.mock('./bootstrap.js', () => ({
  beginActivityBootstrap: mocks.beginActivityBootstrap,
}));

vi.mock('./broker.js', () => ({
  createActivityBroker: mocks.createActivityBroker,
  readActivitySessionContext: mocks.readActivitySessionContext,
  refreshActivitySession: mocks.refreshActivitySession,
  revokeActivitySession: mocks.revokeActivitySession,
}));

vi.mock('@factory-floor/operator-client-ts', () => ({
  createOperatorClient: mocks.createOperatorClient,
  configureDefaultOperatorClient: mocks.configureDefaultOperatorClient,
}));

vi.mock('@factory-floor/operator-ui-react', async () => {
  const { createElement } = await import('react');
  return {
    RunOperatorWorkspace: ({ runId }: { runId: string }) =>
      createElement('div', { 'data-testid': 'run-workspace' }, runId),
  };
});

const disabledConfig: DiscordActivityConfig = {
  enabled: false,
  discordClientId: '',
  brokerUrl: '',
  controlPlaneUrl: '',
  redirectUri: '',
};

function enabledConfig(): DiscordActivityConfig {
  return {
    enabled: true,
    discordClientId: 'application-1',
    brokerUrl: 'https://broker.example',
    controlPlaneUrl: 'https://factory-floor.example',
    redirectUri: 'https://application-1.discordsays.com/.proxy/oauth/callback',
  };
}

describe('Discord Activity shell', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it('stays disabled without initializing the Discord host', () => {
    const createHost = vi.fn();

    render(
      <DiscordActivityApp config={disabledConfig} createHost={createHost} />,
    );

    expect(screen.getByText('This embedded operator is disabled.')).toBeVisible();
    expect(createHost).not.toHaveBeenCalled();
    expect(mocks.createActivityBroker).not.toHaveBeenCalled();
  });

  it('renders only the verified bound run and revokes its in-memory session', async () => {
    const now = Date.now();
    const credentials = {
      sessionToken: 'session-token',
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      idleExpiresAt: new Date(now + 5 * 60_000).toISOString(),
    };
    const host = {
      instanceId: 'instance-1',
      ready: vi.fn(async () => undefined),
      authorize: vi.fn(async () => ({ code: 'code' })),
      authenticate: vi.fn(async () => undefined),
    };
    const broker = {
      startOAuth: vi.fn(),
      bootstrap: vi.fn(),
    };
    const createHost = vi.fn(() => host);
    mocks.createActivityBroker.mockReturnValue(broker);
    mocks.beginActivityBootstrap.mockResolvedValue({
      ...credentials,
      instanceBindingId: 'binding-1',
      projectId: 'project-1',
      runId: 'run-1',
    });
    mocks.readActivitySessionContext.mockResolvedValue({
      instanceBindingId: 'binding-1',
      applicationId: 'application-1',
      instanceId: 'instance-1',
      installationId: 'installation-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      threadId: null,
      principalId: 'discord:user-1',
      adapter: 'discord-agent',
      runId: 'run-1',
      expiresAt: credentials.expiresAt,
      idleExpiresAt: credentials.idleExpiresAt,
    });
    mocks.createOperatorClient.mockReturnValue({ client: true });
    mocks.revokeActivitySession.mockResolvedValue(undefined);

    render(
      <DiscordActivityApp config={enabledConfig()} createHost={createHost} />,
    );

    expect(await screen.findByTestId('run-workspace')).toHaveTextContent('run-1');
    expect(createHost).toHaveBeenCalledWith('application-1');
    expect(mocks.beginActivityBootstrap).toHaveBeenCalledWith({
      host,
      broker,
      redirectUri:
        'https://application-1.discordsays.com/.proxy/oauth/callback',
    });
    expect(mocks.readActivitySessionContext).toHaveBeenCalledWith(
      'https://factory-floor.example',
      'session-token',
    );
    expect(mocks.createOperatorClient).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'session-token',
        principalId: 'discord:user-1',
        adapter: 'discord-agent',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    await waitFor(() =>
      expect(mocks.revokeActivitySession).toHaveBeenCalledWith(
        'https://factory-floor.example',
        'session-token',
      ),
    );
    expect(await screen.findByText('Session expired')).toBeVisible();
  });
});
