export interface DiscordActivityConfig {
  enabled: boolean;
  discordClientId: string;
  brokerUrl: string;
  controlPlaneUrl: string;
  redirectUri: string;
}

function value(
  env: Record<string, string | boolean | undefined>,
  name: string,
): string {
  const result = env[name];
  return typeof result === 'string' ? result.trim() : '';
}

export function discordActivityConfig(
  env: Record<string, string | boolean | undefined>,
): DiscordActivityConfig {
  const enabled =
    value(env, 'VITE_FACTORY_FLOOR_DISCORD_ACTIVITY_ENABLED') === 'true';
  const config = {
    enabled,
    discordClientId: value(env, 'VITE_DISCORD_CLIENT_ID'),
    brokerUrl: value(env, 'VITE_FACTORY_FLOOR_BROKER_URL'),
    controlPlaneUrl: value(env, 'VITE_FACTORY_FLOOR_CONTROL_PLANE_URL'),
    redirectUri: value(env, 'VITE_DISCORD_OAUTH_REDIRECT_URI'),
  };
  if (!enabled) return config;
  for (const [name, item] of Object.entries(config))
    if (name !== 'enabled' && !item)
      throw new Error(`discord_activity_${name}_required`);
  for (const endpoint of [
    config.brokerUrl,
    config.controlPlaneUrl,
    config.redirectUri,
  ]) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost')
      throw new Error('discord_activity_https_required');
  }
  return config;
}
