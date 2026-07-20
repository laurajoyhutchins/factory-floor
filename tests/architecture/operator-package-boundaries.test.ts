import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory()
          ? sourceFiles(path)
          : /\.[cm]?[jt]sx?$/.test(entry.name)
            ? [path]
            : [];
      }),
    )
  ).flat();
}

describe('operator package boundaries', () => {
  it('keeps reusable packages free of host and runtime authority concerns', async () => {
    const roots = [
      'packages/operator-client-ts/src',
      'packages/operator-ui-react/src',
    ];
    const forbidden = [
      /discord/i,
      /@factory-floor\/runtime-core/,
      /@factory-floor\/db/,
      /apps\/control-plane/,
      /WORKER_TOKEN/,
      /ADMIN_TOKEN/,
      /import\.meta/,
    ];

    for (const root of roots)
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, 'utf8');
        for (const pattern of forbidden)
          expect(source, `${file} contains ${pattern}`).not.toMatch(pattern);
      }
  });
});
