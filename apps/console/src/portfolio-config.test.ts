import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('standalone Portfolio configuration', () => {
  it('does not ingest a bearer token from the build-time Vite environment', async () => {
    const source = await readFile(
      new URL('./main.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('VITE_PORTFOLIO_CONTROL_PLANE_URL');
    expect(source).not.toContain('VITE_PORTFOLIO_CONTROL_PLANE_TOKEN');
  });
});
