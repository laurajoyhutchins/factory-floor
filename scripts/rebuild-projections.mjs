import process from 'node:process';
import { URL } from 'node:url';
const server = process.env.FACTORY_FLOOR_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3000';
const response = await globalThis.fetch(new URL('/api/v1/inspect/projections/rebuild', server), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ dryRun: process.argv.includes('--dry-run') }),
});
const json = await response.json().catch(() => ({ error: { message: response.statusText } }));
globalThis.console.log(JSON.stringify(json, null, 2));
if (!response.ok) process.exit(1);
