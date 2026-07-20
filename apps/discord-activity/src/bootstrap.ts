import type {
  ActivityBroker,
  ActivityHost,
  BootstrappedActivity,
} from './contracts.js';
import { createPkce } from './pkce.js';

export async function beginActivityBootstrap(options: {
  host: ActivityHost;
  broker: ActivityBroker;
  redirectUri: string;
  createPkce?: typeof createPkce;
}): Promise<BootstrappedActivity> {
  const redirectUri = options.redirectUri.trim();
  if (!redirectUri) throw new Error('activity_redirect_uri_required');
  if (!options.host.instanceId) throw new Error('activity_instance_id_required');

  await options.host.ready();
  const pkce = await (options.createPkce ?? createPkce)();
  const start = await options.broker.startOAuth({
    instanceId: options.host.instanceId,
    codeChallenge: pkce.challenge,
  });
  if (start.codeChallengeMethod !== 'S256')
    throw new Error('activity_pkce_method_invalid');
  const authorization = await options.host.authorize({
    client_id: start.clientId,
    response_type: 'code',
    state: start.state,
    prompt: 'none',
    scope: start.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  });
  const bootstrap = await options.broker.bootstrap({
    state: start.state,
    instanceId: options.host.instanceId,
    code: authorization.code,
    codeVerifier: pkce.verifier,
    redirectUri,
  });
  if (bootstrap.context.kind !== 'run' || !bootstrap.context.runId)
    throw new Error('activity_run_binding_required');
  if (!bootstrap.factoryFloor.sessionToken)
    throw new Error('activity_session_token_required');

  await options.host.authenticate(bootstrap.discord.accessToken);
  return {
    projectId: bootstrap.context.projectId,
    runId: bootstrap.context.runId,
    instanceBindingId: bootstrap.factoryFloor.instanceBindingId,
    sessionToken: bootstrap.factoryFloor.sessionToken,
    expiresAt: bootstrap.factoryFloor.expiresAt,
    idleExpiresAt: bootstrap.factoryFloor.idleExpiresAt,
  };
}
