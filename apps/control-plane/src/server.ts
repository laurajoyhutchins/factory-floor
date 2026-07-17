import { buildApp } from './app.js';
import { workerAuthorizationFromEnv } from './routes/worker.js';
import { controlPlaneSecurityFromEnv } from './security.js';

const app = await buildApp({
  runStartupRecovery: true,
  controlPlaneSecurity: controlPlaneSecurityFromEnv(process.env),
  workerAuthorization: workerAuthorizationFromEnv(process.env),
});
const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '127.0.0.1';

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
