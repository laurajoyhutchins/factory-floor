export interface ActivityHost {
  readonly instanceId: string;
  ready(): Promise<void>;
  authorize(request: {
    client_id: string;
    response_type: 'code';
    state: string;
    prompt: 'none';
    scope: string[];
    code_challenge: string;
    code_challenge_method: 'S256';
  }): Promise<{ code: string }>;
  authenticate(accessToken: string): Promise<void>;
}

export interface ActivityOAuthStartResponse {
  state: string;
  clientId: string;
  scopes: string[];
  codeChallengeMethod: 'S256';
  expiresAt: number;
}

export interface ActivityBootstrapResponse {
  discord: {
    accessToken: string;
    tokenType: string;
    expiresIn: number;
    scope: string;
  };
  factoryFloor: ActivitySessionCredentials & {
    instanceBindingId: string;
  };
  context: {
    kind: string;
    projectId: string;
    runId?: string;
  };
}

export interface ActivityBroker {
  startOAuth(request: {
    instanceId: string;
    codeChallenge: string;
  }): Promise<ActivityOAuthStartResponse>;
  bootstrap(request: {
    state: string;
    instanceId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ActivityBootstrapResponse>;
}

export interface ActivitySessionCredentials {
  sessionToken: string;
  expiresAt: string;
  idleExpiresAt: string;
}

export interface ActivitySessionContext {
  instanceBindingId: string;
  applicationId: string;
  instanceId: string;
  installationId: string;
  guildId: string | null;
  channelId: string | null;
  threadId: string | null;
  principalId: string;
  adapter: string;
  runId: string;
  expiresAt: string;
  idleExpiresAt: string;
}

export interface BootstrappedActivity extends ActivitySessionCredentials {
  instanceBindingId: string;
  projectId: string;
  runId: string;
}
