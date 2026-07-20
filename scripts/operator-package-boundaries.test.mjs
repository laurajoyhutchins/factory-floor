import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

function sourceFiles(directory) {
  return readdirSync(join(root, directory)).flatMap((entry) => {
    const relative = join(directory, entry);
    const absolute = join(root, relative);
    if (statSync(absolute).isDirectory()) return sourceFiles(relative);
    return /\.(?:ts|tsx|js|jsx)$/.test(entry) ? [relative] : [];
  });
}

const bannedReusableImports = [
  '@discord',
  'discord.js',
  '@factory-floor/db',
  '@factory-floor/runtime-core',
  '@factory-floor/worker-sdk',
  'apps/control-plane',
  'workers/',
  'WORKER_API_BEARER_TOKEN',
  'CONTROL_PLANE_ADMIN_TOKEN',
];

describe('reusable operator package extraction', () => {
  it('defines a transport-neutral operator client package', () => {
    const packageJson = json('packages/operator-client-ts/package.json');
    const source = read('packages/operator-client-ts/src/index.ts');

    expect(packageJson.name).toBe('@factory-floor/operator-client');
    expect(packageJson.exports['.']).toBe('./src/index.ts');
    expect(source).toContain('export function createOperatorClient');
    expect(source).toContain('export class OperatorApiError');
    expect(source).toContain('mergeFiniteRunEvents');
    expect(source).toContain('shouldRetryOperatorRequest');
    expect(source).not.toContain('import.meta.env');
  });

  it('defines reusable React views with an injected client boundary', () => {
    const packageJson = json('packages/operator-ui-react/package.json');
    const source = read('packages/operator-ui-react/src/index.ts');
    const provider = read('packages/operator-ui-react/src/provider.tsx');

    expect(packageJson.name).toBe('@factory-floor/operator-ui-react');
    expect(packageJson.peerDependencies.react).toBeDefined();
    expect(source).toContain('OperatorClientProvider');
    expect(source).toContain('Overview');
    expect(source).toContain('Topology');
    expect(source).toContain('TemplateInstantiations');
    expect(provider).toContain('useOperatorClient');
    expect(
      existsSync(
        join(root, 'packages/operator-ui-react/src/minimal-shell.test.tsx'),
      ),
    ).toBe(true);
  });

  it('keeps authority, credentials, and host SDKs outside reusable packages', () => {
    const reusableSources = [
      ...sourceFiles('packages/operator-client-ts/src'),
      ...sourceFiles('packages/operator-ui-react/src'),
    ];
    const combined = reusableSources.map(read).join('\n');

    for (const banned of bannedReusableImports) {
      expect(combined, `unexpected reusable-package dependency: ${banned}`).not.toContain(
        banned,
      );
    }
  });

  it('migrates the standalone console into a thin shell', () => {
    const packageJson = json('apps/console/package.json');
    const main = read('apps/console/src/main.tsx');

    expect(packageJson.dependencies['@factory-floor/operator-client']).toBe(
      'workspace:*',
    );
    expect(packageJson.dependencies['@factory-floor/operator-ui-react']).toBe(
      'workspace:*',
    );
    expect(main).toContain("from '@factory-floor/operator-client'");
    expect(main).toContain("from '@factory-floor/operator-ui-react'");
    expect(main).toContain('VITE_FACTORY_FLOOR_OPERATOR_TOKEN');
    expect(main).toContain('OperatorClientProvider');

    for (const migrated of [
      'apps/console/src/api/client.ts',
      'apps/console/src/api/adapters.tsx',
      'apps/console/src/components/ui.tsx',
      'apps/console/src/hooks/liveEvents.ts',
      'apps/console/src/pages/pages.tsx',
      'apps/console/src/pages/template-instantiations.tsx',
    ]) {
      expect(existsSync(join(root, migrated)), `${migrated} should be migrated`).toBe(
        false,
      );
    }
  });

  it('includes both reusable packages in root TypeScript verification', () => {
    const references = json('tsconfig.json').references.map(({ path }) => path);
    expect(references).toContain('packages/operator-client-ts');
    expect(references).toContain('packages/operator-ui-react');
  });
});
