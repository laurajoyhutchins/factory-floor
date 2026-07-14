import Fastify, { type FastifyInstance } from 'fastify';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok', service: 'control-plane' }));

  return app;
}
