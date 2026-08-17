import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const EXPECTED_FIXTURE_DIGEST =
  '5b7a2b9717dc572ea6967e9b17b487b99213587463d23f3c36a933977d6f4b0d';

interface BootstrapFixture {
  schemaVersion: number;
  protocol: string;
  oauthStart: {
    request: { instanceId: string; codeChallenge: string };
    response: { state: string; codeChallengeMethod: string };
  };
  bootstrap: {
    request: { state: string; instanceId: string; codeVerifier: string };
    factoryFloorRequest: Record<string, unknown>;
    response: Record<string, unknown>;
  };
}

const fixtureUrl = new URL(
  '../../../contracts/discord-activity/bootstrap-v1.json',
  import.meta.url,
);
const fixtureBytes = readFileSync(fixtureUrl);
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as BootstrapFixture;

describe('Discord Activity bootstrap contract fixture', () => {
  it('has the shared versioned raw digest', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      EXPECTED_FIXTURE_DIGEST,
    );
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      protocol: 'discord-agent-activity-bootstrap',
    });
  });

  it('contains a coherent S256 PKCE vector', () => {
    expect(
      createHash('sha256')
        .update(fixture.bootstrap.request.codeVerifier)
        .digest('base64url'),
    ).toBe(fixture.oauthStart.request.codeChallenge);
    expect(fixture.oauthStart.response.codeChallengeMethod).toBe('S256');
    expect(fixture.oauthStart.response.state).toBe(
      fixture.bootstrap.request.state,
    );
  });

  it('freezes the command-scoped session request accepted by Factory Floor', () => {
    expect(fixture.bootstrap.factoryFloorRequest).toEqual({
      applicationId: 'application-1',
      instanceId: 'i-launch-1-gc-guild-1-thread-1',
      installationId: 'guild-1',
      guildId: 'guild-1',
      channelId: 'agent-1',
      threadId: 'thread-1',
      launchId: 'launch-1',
      principalId: 'user-1',
      adapter: 'discord-agent',
      boundCommandId: 'command-1',
    });
    expect(fixture.bootstrap.response).toMatchObject({
      factoryFloor: { instanceBindingId: 'binding-1' },
      context: {
        kind: 'command',
        projectId: 'ff-project-1',
        commandId: 'command-1',
      },
    });
  });
});
