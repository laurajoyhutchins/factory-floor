import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('standalone Portfolio configuration', () => {
  it('does not ingest a bearer token from the build-time Vite environment', async () => {
    const source = await readFile(
      join(process.cwd(), 'apps/console/src/main.tsx'),
      'utf8',
    );

    expect(source).toContain('VITE_PORTFOLIO_CONTROL_PLANE_URL');
    expect(source).not.toContain('VITE_PORTFOLIO_CONTROL_PLANE_TOKEN');
  });
});
