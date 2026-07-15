import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

describe('ff cli', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts YAML to the expected endpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-'));
    const file = join(directory, 'schema.yaml');
    writeFileSync(file, 'apiVersion: factory-floor.dev/v1alpha1\nkind: ArtifactSchema\nmetadata: {name: n, version: "1"}\nspec: {}\n');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ disposition: 'created', digest: 'a' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await main(['schema', 'register', file, '--server', 'http://s', '--json']);

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://s/api/v1/registrations/artifact-schemas');
  });

  it('selects the requested declaration from a multi-document YAML file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-'));
    const file = join(directory, 'system.yaml');
    writeFileSync(file, [
      'apiVersion: factory-floor.dev/v1alpha1',
      'kind: System',
      'metadata: {name: system, version: "1"}',
      'spec: {rootRegion: {id: root}, regions: []}',
      '---',
      'apiVersion: factory-floor.dev/v1alpha1',
      'kind: Template',
      'metadata: {name: template, version: "1"}',
      'spec: {}',
      '',
    ].join('\n'));
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => new Response(JSON.stringify({
      disposition: 'created',
      digest: JSON.parse(String(init?.body)).kind,
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await main(['system', 'apply', file, '--server', 'http://s', '--json']);

    expect(code).toBe(0);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ kind: 'System' });
  });
});
