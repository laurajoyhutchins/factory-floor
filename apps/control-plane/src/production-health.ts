import type { FastifyInstance } from 'fastify';

export type ProductionDependencyName = 'database' | 'artifactStore';
export type ProductionDependencyStatus = 'ready' | 'not_ready';

export interface ProductionReadinessReport {
  status: 'ready' | 'not_ready';
  service: 'control-plane';
  checks: Record<ProductionDependencyName, ProductionDependencyStatus>;
}

export class ProductionReadinessService {
  constructor(
    private readonly checks: Record<
      ProductionDependencyName,
      () => Promise<unknown>
    >,
  ) {}

  async inspect(): Promise<{
    report: ProductionReadinessReport;
    failures: { name: ProductionDependencyName; error: unknown }[];
  }> {
    const entries = await Promise.all(
      (
        Object.entries(this.checks) as [
          ProductionDependencyName,
          () => Promise<unknown>,
        ][]
      ).map(async ([name, check]) => {
        try {
          await check();
          return { name, status: 'ready' as const };
        } catch (error) {
          return { name, status: 'not_ready' as const, error };
        }
      }),
    );
    const failures = entries
      .filter(
        (
          entry,
        ): entry is {
          name: ProductionDependencyName;
          status: 'not_ready';
          error: unknown;
        } => entry.status === 'not_ready',
      )
      .map(({ name, error }) => ({ name, error }));
    const checks = Object.fromEntries(
      entries.map(({ name, status }) => [name, status]),
    ) as Record<ProductionDependencyName, ProductionDependencyStatus>;

    return {
      report: {
        status: failures.length === 0 ? 'ready' : 'not_ready',
        service: 'control-plane',
        checks,
      },
      failures,
    };
  }
}

export function registerProductionHealthRoutes(
  app: FastifyInstance,
  readiness: ProductionReadinessService,
): void {
  app.get('/health/live', async () => ({
    status: 'ok',
    service: 'control-plane',
  }));
  app.get('/health/ready', async (_request, reply) => {
    const { report, failures } = await readiness.inspect();
    for (const failure of failures)
      app.log.warn(
        { dependency: failure.name, err: failure.error },
        'production readiness dependency failed',
      );
    return reply.code(report.status === 'ready' ? 200 : 503).send(report);
  });
}
