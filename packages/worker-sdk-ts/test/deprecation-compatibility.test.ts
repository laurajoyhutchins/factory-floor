import { describe, expect, it } from 'vitest';
import { ComponentRegistry } from '../src/index.js';

describe('worker protocol v1 compatibility aliases', () => {
  it('keeps capabilities as an exact alias for canonical component selectors', () => {
    const registry = new ComponentRegistry();
    registry.register('verify', '1', async () => {
      throw new Error('unused');
    });
    registry.register('retrieve', '1', async () => {
      throw new Error('unused');
    });

    expect(registry.capabilities()).toEqual(
      registry.supportedComponentSelectors(),
    );
    expect(registry.capabilities()).toEqual(['retrieve@1', 'verify@1']);
  });
});
