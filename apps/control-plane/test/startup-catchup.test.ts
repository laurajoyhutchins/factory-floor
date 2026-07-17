import { describe, expect, it, vi } from 'vitest';
import { drainProjectionCatchUp } from '../src/app.js';

describe('startup projection catch-up', () => {
  it('continues bounded batches until no work remains', async () => {
    const rebuildProjections = vi
      .fn()
      .mockResolvedValueOnce({ pending: true })
      .mockResolvedValueOnce({ pending: true })
      .mockResolvedValueOnce({ pending: false });
    const yieldControl = vi.fn(async () => undefined);

    await expect(
      drainProjectionCatchUp(
        { rebuildProjections } as never,
        250,
        () => false,
        yieldControl,
      ),
    ).resolves.toBe(3);
    expect(rebuildProjections).toHaveBeenCalledTimes(3);
    expect(rebuildProjections).toHaveBeenCalledWith(250);
    expect(yieldControl).toHaveBeenCalledTimes(2);
  });

  it('stops without issuing another batch after shutdown is requested', async () => {
    const rebuildProjections = vi.fn(async () => ({ pending: true }));
    let stopped = false;

    await expect(
      drainProjectionCatchUp(
        { rebuildProjections } as never,
        250,
        () => stopped,
        async () => {
          stopped = true;
        },
      ),
    ).resolves.toBe(1);
    expect(rebuildProjections).toHaveBeenCalledTimes(1);
  });
});
