import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new globalThis.URL('..', import.meta.url));
const schemaDir = join(root, 'contracts', 'schemas');
const paths = readdirSync(schemaDir, { recursive: true })
  .filter((name) => String(name).endsWith('.schema.json'))
  .sort()
  .map((name) => join(schemaDir, String(name)));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const schemas = paths.map((path) => ({
  path,
  schema: JSON.parse(readFileSync(path, 'utf8')),
}));

for (const { path, schema } of schemas) {
  const key =
    typeof schema.$id === 'string' && schema.$id.length > 0
      ? schema.$id
      : pathToFileURL(path).href;
  ajv.addSchema(schema, key);
}
for (const { path, schema } of schemas) {
  const key =
    typeof schema.$id === 'string' && schema.$id.length > 0
      ? schema.$id
      : pathToFileURL(path).href;
  if (!ajv.getSchema(key)) throw new Error(`Failed to compile schema ${relative(root, path)}`);
}

globalThis.console.log(
  `Validated ${schemas.length} contract schemas:\n${paths
    .map((path) => `- ${relative(root, path)}`)
    .join('\n')}`,
);
