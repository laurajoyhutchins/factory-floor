import { DiscordSDK } from '@discord/embedded-app-sdk';
import type { ActivityHost } from './contracts.js';

export function createDiscordActivityHost(clientId: string): ActivityHost {
  const id = clientId.trim();
  if (!id) throw new Error('discord_client_id_required');
  const sdk = new DiscordSDK(id);

  return {
    instanceId: sdk.instanceId,
    ready: () => sdk.ready(),
    authorize: async (request) => {
      const result = await sdk.commands.authorize(
        request as Parameters<typeof sdk.commands.authorize>[0],
      );
      if (!result?.code) throw new Error('discord_authorization_code_required');
      return { code: result.code };
    },
    authenticate: async (accessToken) => {
      const result = await sdk.commands.authenticate({
        access_token: accessToken,
      });
      if (!result) throw new Error('discord_authentication_failed');
    },
  };
}
