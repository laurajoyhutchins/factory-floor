#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

function arg(argv: string[], name: string, defaultValue?: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : defaultValue;
}

interface CommandRoute {
  readonly endpoint: string;
  readonly kind: string;
}

const routes: Record<string, CommandRoute> = {
  'schema register': { endpoint: '/api/v1/registrations/artifact-schemas', kind: 'ArtifactSchema' },
  'component register': { endpoint: '/api/v1/registrations/component-definitions', kind: 'ComponentDefinition' },
  'template register': { endpoint: '/api/v1/registrations/templates', kind: 'Template' },
  'policy register': { endpoint: '/api/v1/registrations/policies', kind: 'Policy' },
  'system apply': { endpoint: '/api/v1/systems/apply', kind: 'System' },
  'command submit': { endpoint: '/api/v1/commands', kind: 'Command' },
};

function load(file: string, expectedKind: string): any {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);

  const documents = parseAllDocuments(text);
  for (const document of documents) {
    if (document.errors.length > 0) throw document.errors[0];
  }
  const values = documents.map((document) => document.toJS()).filter((value) => value !== null);
  if (values.length === 1) return values[0];

  const matches = values.filter((value) => (
    typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === expectedKind
  ));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${expectedKind} declaration in ${file}, found ${matches.length}`);
  }
  return matches[0];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const key = `${argv[0] ?? ''} ${argv[1] ?? ''}`;
  const route = routes[key];
  const file = argv[2];
  const server = arg(argv, '--server', 'http://127.0.0.1:3000')!;
  const asJson = argv.includes('--json');

  if (route === undefined || file === undefined) {
    console.error('Usage: ff <schema|component|template|policy> register <file> [--server URL] [--json]\n       ff system apply <file> [--server URL] [--json]\n       ff command submit <file> [--server URL] [--json] [--idempotency-key KEY] [--correlation-id ID]');
    return 2;
  }

  try {
    const body = load(file, route.kind);
    if (key === 'command submit') {
      const idem = arg(argv, '--idempotency-key');
      const corr = arg(argv, '--correlation-id');
      if (idem) body.idempotencyKey = idem;
      if (corr) body.correlationId = corr;
    }
    const response = await fetch(new URL(route.endpoint, server), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({ error: { code: 'transport_error', message: response.statusText } })) as {
      disposition?: string;
      digest?: string;
      commandId?: string;
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      console.error(asJson ? JSON.stringify(json) : `${json.error?.code ?? 'error'}: ${json.error?.message ?? response.statusText}`);
      return 1;
    }
    console.log(asJson ? JSON.stringify(json) : (key === 'command submit' ? `${json.disposition} ${json.commandId ?? ''}` : `${json.disposition} ${json.digest}`));
    return 0;
  } catch (error) {
    const message = (error as Error).message;
    console.error(asJson ? JSON.stringify({ error: { code: 'transport_error', message } }) : message);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
