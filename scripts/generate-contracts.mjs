import { compileFromFile } from 'json-schema-to-typescript';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, join, relative } from 'node:path';

const root = fileURLToPath(new globalThis.URL('..', import.meta.url));
const schemaDir = join(root, 'contracts', 'schemas');
const schemaPaths = readdirSync(schemaDir).filter((name) => name.endsWith('.schema.json')).sort().map((name) => join(schemaDir, name));

const tsOut = join(root, 'packages', 'contracts-ts', 'src', 'generated');
rmSync(tsOut, { recursive: true, force: true });
mkdirSync(tsOut, { recursive: true });
const exports = [];
for (const schemaPath of schemaPaths) {
  const base = basename(schemaPath, '.schema.json');
  const ts = await compileFromFile(schemaPath, {
    bannerComment: '/** Generated from JSON Schema. Do not edit by hand. */',
    cwd: schemaDir,
    style: { singleQuote: true, semi: true },
    unreachableDefinitions: true,
  });
  const outName = `${base}.ts`;
  writeFileSync(join(tsOut, outName), ts);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  if (typeof schema.title === 'string') {
    exports.push(`export type { ${schema.title} } from './generated/${base}.js';`);
  }
}
writeFileSync(join(root, 'packages', 'contracts-ts', 'src', 'index.ts'), `${exports.join('\n')}\n`);

const pyOut = join(root, 'packages', 'contracts-py', 'factory_floor_contracts');
rmSync(pyOut, { recursive: true, force: true });
mkdirSync(pyOut, { recursive: true });
execFileSync('uv', [
  'run', '--project', join(root, 'packages', 'contracts-py'), '--locked', 'datamodel-codegen',
  '--input', schemaDir,
  '--input-file-type', 'jsonschema',
  '--output', pyOut,
  '--output-model-type', 'pydantic_v2.BaseModel',
  '--target-python-version', '3.12',
  '--use-schema-description',
  '--disable-timestamp',
  '--formatters', 'black', 'isort',
], { stdio: 'inherit' });

const pyModules = schemaPaths.map((schemaPath) => basename(schemaPath, '.schema.json').replaceAll('-', '_') + '_schema');
writeFileSync(join(pyOut, '__init__.py'), `"""Generated Factory Floor Pydantic contract models."""
${pyModules.map((moduleName) => `from .${moduleName} import *  # noqa: F401,F403`).join('\n')}
`);

globalThis.console.log(`Generated ${schemaPaths.length} schemas from sorted paths:\n${schemaPaths.map((p) => `- ${relative(root, p)}`).join('\n')}`);
