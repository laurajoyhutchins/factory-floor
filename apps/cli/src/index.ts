#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

function arg(
  argv: string[],
  name: string,
  defaultValue?: string,
): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : defaultValue;
}

interface CommandRoute {
  readonly endpoint: string;
  readonly kind: string;
}

const inspectRoutes: Record<string, string> = {
  'inspect regions': '/api/v1/inspect/regions',
  'inspect events': '/api/v1/inspect/events',
  'inspect deliveries': '/api/v1/inspect/deliveries',
  'inspect executions': '/api/v1/inspect/executions',
  'inspect attempts': '/api/v1/inspect/attempts',
  'inspect artifacts': '/api/v1/inspect/artifacts',
  'inspect resources': '/api/v1/inspect/resources',
  'inspect policy-decisions': '/api/v1/inspect/policy-decisions',
  'inspect projections': '/api/v1/inspect/projections',
};

function human(value: any): string {
  if (Array.isArray(value?.items))
    return (
      value.items
        .map((item: any) =>
          Object.entries(item)
            .filter(
              ([, v]) => v !== null && v !== undefined && typeof v !== 'object',
            )
            .map(([k, v]) => `${k}=${v}`)
            .join(' '),
        )
        .join('\n') || '(empty)'
    );
  return JSON.stringify(value, null, 2);
}

const routes: Record<string, CommandRoute> = {
  'schema register': {
    endpoint: '/api/v1/registrations/artifact-schemas',
    kind: 'ArtifactSchema',
  },
  'component register': {
    endpoint: '/api/v1/registrations/component-definitions',
    kind: 'ComponentDefinition',
  },
  'template register': {
    endpoint: '/api/v1/registrations/templates',
    kind: 'Template',
  },
  'policy register': {
    endpoint: '/api/v1/registrations/policies',
    kind: 'Policy',
  },
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
  const values = documents
    .map((document) => document.toJS())
    .filter((value) => value !== null);
  if (values.length === 1) return values[0];

  const matches = values.filter(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      (value as { kind?: unknown }).kind === expectedKind,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${expectedKind} declaration in ${file}, found ${matches.length}`,
    );
  }
  return matches[0];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const key = `${argv[0] ?? ''} ${argv[1] ?? ''}`;
  const inspectRoute = inspectRoutes[key];
  const route = routes[key];
  const file = argv[2];
  const server = arg(argv, '--server', 'http://127.0.0.1:3000')!;
  const asJson = argv.includes('--json');

  if (inspectRoute) {
    try {
      const id = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
      const endpoint =
        key === 'inspect executions' && id
          ? `/api/v1/inspect/executions/${id}`
          : key === 'inspect artifacts' && id
            ? `/api/v1/inspect/artifacts/${id}/lineage`
            : inspectRoute;
      const url = new URL(endpoint, server);
      const cursor = arg(argv, '--cursor');
      const lim = arg(argv, '--limit');
      if (cursor) url.searchParams.set('cursor', cursor);
      if (lim) url.searchParams.set('limit', lim);
      const response = await fetch(url);
      const json = await response.json();
      if (!response.ok) {
        console.error(
          asJson
            ? JSON.stringify(json)
            : `${json.error?.code ?? 'error'}: ${json.error?.message ?? response.statusText}`,
        );
        return 1;
      }
      console.log(asJson ? JSON.stringify(json) : human(json));
      return 0;
    } catch (error) {
      const message = (error as Error).message;
      console.error(
        asJson
          ? JSON.stringify({ error: { code: 'transport_error', message } })
          : message,
      );
      return 1;
    }
  }

  if (route === undefined || file === undefined) {
    console.error(
      'Usage: ff <schema|component|template|policy> register <file> [--server URL] [--json]\n       ff system apply <file> [--server URL] [--json]\n       ff command submit <file> [--server URL] [--json] [--idempotency-key KEY] [--correlation-id ID]\n       ff inspect <regions|events|deliveries|executions|attempts|artifacts|resources|policy-decisions|projections> [id] [--server URL] [--json] [--cursor CURSOR] [--limit N]',
    );
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
    const json = (await response.json().catch(() => ({
      error: { code: 'transport_error', message: response.statusText },
    }))) as {
      disposition?: string;
      digest?: string;
      commandId?: string;
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      console.error(
        asJson
          ? JSON.stringify(json)
          : `${json.error?.code ?? 'error'}: ${json.error?.message ?? response.statusText}`,
      );
      return 1;
    }
    console.log(
      asJson
        ? JSON.stringify(json)
        : key === 'command submit'
          ? `${json.disposition} ${json.commandId ?? ''}`
          : `${json.disposition} ${json.digest}`,
    );
    return 0;
  } catch (error) {
    const message = (error as Error).message;
    console.error(
      asJson
        ? JSON.stringify({ error: { code: 'transport_error', message } })
        : message,
    );
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
