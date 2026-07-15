import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
describe('ff cli', () => { afterEach(()=>vi.restoreAllMocks()); it('posts YAML to the expected endpoint', async () => { const dir=mkdtempSync(join(tmpdir(),'ff-')); const f=join(dir,'s.yaml'); writeFileSync(f,'apiVersion: factory-floor.dev/v1alpha1\nkind: ArtifactSchema\nmetadata: {name: n, version: "1"}\nspec: {}\n'); const fetch=vi.fn(async()=>new Response(JSON.stringify({disposition:'created',digest:'a'}),{status:201,headers:{'content-type':'application/json'}})); vi.stubGlobal('fetch',fetch); const code=await main(['schema','register',f,'--server','http://s','--json']); expect(code).toBe(0); expect(String(fetch.mock.calls[0][0])).toBe('http://s/api/v1/registrations/artifact-schemas'); }); });
