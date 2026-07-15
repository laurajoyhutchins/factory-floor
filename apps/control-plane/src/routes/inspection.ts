import {
  encodeInspectionCursor,
  type ObservabilityService,
} from '@factory-floor/runtime-core';
import type { FastifyInstance, FastifyReply } from 'fastify';

function pageQuery(request: { query: unknown }) {
  const query = request.query as { cursor?: string; limit?: string | number };
  return {
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : Number(query.limit),
  };
}

function inspectionError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : 'inspection_error';
  const statusCode = [
    'invalid_cursor',
    'invalid_limit',
    'invalid_batch_size',
  ].includes(code)
    ? 400
    : 500;
  return reply.code(statusCode).send({
    error: {
      code,
      message:
        statusCode === 400
          ? 'The inspection request is invalid.'
          : 'The inspection request failed.',
    },
  });
}

async function inspect<T>(
  reply: FastifyReply,
  operation: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    return inspectionError(reply, error);
  }
}

export async function registerInspectionRoutes(
  app: FastifyInstance,
  service: ObservabilityService,
) {
  app.get('/api/v1/inspect/regions', async (request, reply) =>
    inspect(reply, () => service.listRegions(pageQuery(request))),
  );
  app.get('/api/v1/inspect/events', async (request, reply) =>
    inspect(reply, () => service.listEvents(pageQuery(request))),
  );
  app.get('/api/v1/inspect/deliveries', async (request, reply) =>
    inspect(reply, () => service.listDeliveries(pageQuery(request))),
  );
  app.get('/api/v1/inspect/executions', async (request, reply) =>
    inspect(reply, () => service.listExecutions(pageQuery(request))),
  );
  app.get('/api/v1/inspect/executions/:id', async (request, reply) => {
    const trace = await inspect(reply, () =>
      service.executionTrace((request.params as { id: string }).id),
    );
    if (trace === null)
      return reply.code(404).send({
        error: { code: 'execution_not_found', message: 'Execution not found.' },
      });
    return trace;
  });
  app.get('/api/v1/inspect/executions/:id/attempts', async (request, reply) =>
    inspect(reply, () =>
      service.listAttempts(
        (request.params as { id: string }).id,
        pageQuery(request),
      ),
    ),
  );
  app.get('/api/v1/inspect/attempts', async (request, reply) =>
    inspect(reply, () => service.listAttempts(undefined, pageQuery(request))),
  );
  app.get('/api/v1/inspect/artifacts', async (request, reply) =>
    inspect(reply, () => service.listArtifacts(pageQuery(request))),
  );
  app.get('/api/v1/inspect/artifacts/:id/lineage', async (request, reply) => {
    const lineage = await inspect(reply, () =>
      service.artifactLineage((request.params as { id: string }).id),
    );
    if (lineage === null)
      return reply.code(404).send({
        error: { code: 'artifact_not_found', message: 'Artifact not found.' },
      });
    return lineage;
  });
  app.get('/api/v1/inspect/projections', async (_request, reply) =>
    inspect(reply, async () => ({ items: await service.projectionStatus() })),
  );
  app.post('/api/v1/inspect/projections/rebuild', async (request, reply) =>
    inspect(reply, () =>
      service.rebuildProjections(
        Number(
          (request.body as { batchSize?: number } | undefined)?.batchSize ??
            500,
        ),
      ),
    ),
  );

  app.get('/api/v1/inspect/stream', async (request, reply) => {
    const query = request.query as { cursor?: string; limit?: string };
    const lastEventId = request.headers['last-event-id'];
    const cursor =
      query.cursor ??
      (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
    let page;
    try {
      page = await service.listEvents({
        cursor,
        limit: Number(query.limit ?? 25),
      });
    } catch (error) {
      return inspectionError(reply, error);
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    reply.raw.write(': inspection batch\n\n');
    for (const event of page.items) {
      const eventCursor = encodeInspectionCursor(String(event.id));
      reply.raw.write(
        `id: ${eventCursor}\nevent: runtime-summary\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
    reply.raw.write(
      `event: checkpoint\ndata: ${JSON.stringify({ nextCursor: page.nextCursor })}\n\n`,
    );
    reply.raw.end();
    return reply;
  });
}
