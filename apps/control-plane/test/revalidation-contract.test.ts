import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const EXPECTED_FIXTURE_DIGEST =
  '9e1d155cfc79f61bc373ada6a35a9157cbe557894fe58fcc7ea0ec193c9395ef';

interface RevalidationFixture {
  schemaVersion: number;
  protocol: string;
  endpoint: {
    method: string;
    path: string;
    authenticationDirection: string;
  };
  allow: {
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  };
  deny: {
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  };
  reasonCodes: string[];
}

const fixtureUrl = new URL(
  '../../../contracts/discord-activity/revalidation-v1.json',
  import.meta.url,
);
const fixtureBytes = readFileSync(fixtureUrl);
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as RevalidationFixture;

describe('Discord Activity revalidation contract fixture', () => {
  it('matches the shared raw digest and endpoint version', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      EXPECTED_FIXTURE_DIGEST,
    );
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      protocol: 'discord-agent-activity-revalidation',
      endpoint: {
        method: 'POST',
        path: '/api/v1/discord/activity/revalidate',
        authenticationDirection: 'ff-to-agent',
      },
    });
  });

  it('freezes action-specific allow and deny envelopes', () => {
    expect(fixture.allow.request).toMatchObject({
      instanceId: 'i-launch-1-gc-guild-1-thread-1',
      principalId: 'user-1',
      projectId: 'ff-project-1',
      runId: 'run-1',
      action: 'approve',
    });
    expect(fixture.allow.response).toEqual({
      schemaVersion: 1,
      allowed: true,
      reasonCode: 'authorized',
      action: 'approve',
      principalId: 'user-1',
      runId: 'run-1',
      revalidatedAt: 2000,
    });
    expect(fixture.deny.response).toEqual({
      schemaVersion: 1,
      allowed: false,
      reasonCode: 'not_authorized',
      action: 'cancel',
      revalidatedAt: 2000,
    });
  });

  it('contains the stable denial vocabulary without Discord role data', () => {
    expect(fixture.reasonCodes).toEqual([
      'authorized',
      'invalid_request',
      'unsupported_action',
      'rate_limited',
      'activity_instance_not_found',
      'activity_instance_unavailable',
      'activity_application_mismatch',
      'activity_location_mismatch',
      'activity_principal_not_present',
      'installation_mismatch',
      'guild_mismatch',
      'member_not_found',
      'member_unavailable',
      'principal_mismatch',
      'not_authorized',
      'project_binding_not_found',
      'surface_binding_not_found',
      'run_binding_not_found',
      'binding_mismatch',
      'adapter_mismatch',
    ]);
    expect(JSON.stringify(fixture)).not.toContain('roleIds');
    expect(JSON.stringify(fixture)).not.toContain('signature');
  });
});
