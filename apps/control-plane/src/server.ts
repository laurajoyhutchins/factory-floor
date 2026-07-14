import { buildApp } from './app.js';

declare const process: {
  env: Record<string, string | undefined>;
};

const app = buildApp();
const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '0.0.0.0';

await app.listen({ port, host });
