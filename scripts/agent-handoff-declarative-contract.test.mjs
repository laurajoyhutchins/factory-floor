import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { determineHandoffState } from './agent-pr-handoff-state.mjs';

describe('declarative agent handoff', () => {
  it('returns repository facts without an action instruction', () => {
    const state = determineHandoffState({
      draft: false,
      verificationRun: { status: 'completed', conclusion: 'success' },
      reviewThreads: { status: 'available', unresolvedCount: 0 },
      mergeable: true,
      mergeableState: 'clean',
    });
    expect(state).toEqual({ state: 'ready', externalBlocker: null });
    expect(state).not.toHaveProperty('nextAction');
  });

  it('does not serialize action-bearing fields in the sticky workflow', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/agent-pr-handoff.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).not.toContain('nextAction');
    expect(workflow).not.toContain('Next action');
  });
});
