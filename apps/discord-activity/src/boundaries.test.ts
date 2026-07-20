import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = resolve(root, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const repositoryRoot = resolve(import.meta.dirname, '../../..');

describe('Discord Activity architecture boundaries', () => {
  it('keeps the Discord SDK in the host adapter only', () => {
    const sourceFiles = files(resolve(repositoryRoot, 'apps/discord-activity/src'))
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'));
    const sdkImports = sourceFiles.filter((path) =>
      readFileSync(path, 'utf8').includes('@discord/embedded-app-sdk'),
    );
    expect(sdkImports.map((path) => path.split('/').at(-1))).toEqual([
      'discord-host.ts',
    ]);
  });

  it('does not persist session or service credentials in browser storage', () => {
    const source = files(resolve(repositoryRoot, 'apps/discord-activity/src'))
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
    expect(source).not.toMatch(/CONTROL_PLANE_(ADMIN|OPERATOR)_TOKEN/);
    expect(source).not.toMatch(/SERVICE_AUTH|WORKER_API_BEARER/);
  });

  it('keeps reusable operator packages Discord-free', () => {
    for (const packageName of ['operator-client-ts', 'operator-ui-react']) {
      const source = files(resolve(repositoryRoot, `packages/${packageName}/src`))
        .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n');
      expect(source).not.toContain('@discord/');
      expect(source).not.toMatch(/DiscordSDK|discordSdk/);
    }
  });
});
