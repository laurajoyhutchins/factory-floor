import process from 'node:process';
import { URL } from 'node:url';

const server =
  process.env.FACTORY_FLOOR_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3000';
const batchSize = Number(process.env.FACTORY_FLOOR_PROJECTION_BATCH_SIZE ?? 500);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
  throw new Error(
    'FACTORY_FLOOR_PROJECTION_BATCH_SIZE must be an integer from 1 to 10000',
  );
}

const response = await globalThis.fetch(
  new URL('/api/v1/inspect/projections/rebuild', server),
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchSize }),
    signal: globalThis.AbortSignal.timeout(30_000),
  },
);
const json = await response
  .json()
  .catch(() => ({ error: { message: response.statusText } }));
globalThis.console.log(JSON.stringify(json, null, 2));
if (!response.ok) process.exit(1);
