import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const schemaPath = resolve('tools/deciduous/artifact-coordinate.schema.json');
const coordinatePath = resolve(
  'tools/deciduous/deciduous-0.16.0-linux-amd64.coordinate.json',
);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('Deciduous artifact coordinate', () => {
  it('satisfies the neutral reviewed-binary contract', async () => {
    const schema = await readJson(schemaPath);
    const coordinate = await readJson(coordinatePath);
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);

    expect(ajv.validate(schema, coordinate), ajv.errorsText()).toBe(true);
  });

  it(
    'matches the reviewed Offline Execution Deciduous payload identity',
    async () => {
      const coordinate = await readJson(coordinatePath);

      expect(coordinate).toMatchObject({
        tool_name: 'deciduous',
        version: '0.16.0',
        target_platform: 'x86_64-unknown-linux-musl',
        sha256:
          '6bb5a475124ff5453fd088d13ae092593d9d8dea8bafecec9e4e5192216ada0e',
        source_provenance: {
          repository: 'notactuallytreyanastasio/deciduous',
          commit: '33002b3713752f69a98acaedb42efbc3316deaeb',
          release_tag: 'v0.16.0',
        },
        review_status: 'reviewed',
        storage_location: {
          authority: 'laurajoyhutchins/offline-execution',
          path: 'tools/deciduous/0.16.0-linux-amd64/manifest.json#payload',
        },
        verification_date: '2026-07-30',
      });
    },
  );
});
