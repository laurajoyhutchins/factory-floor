import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

function parseJsonObjectAt(text: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error('acceptance summary JSON was not terminated');
}

describe('Milestone 1 live restart acceptance harness', () => {
  it('runs the process-level restart scenario without duplicate work', async () => {
    const { stdout } = await execFileAsync(
      'node',
      ['scripts/run-m1-live-restart-acceptance.mjs'],
      {
        timeout: 180_000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          FACTORY_FLOOR_ACCEPTANCE_PORT: '3113',
          FACTORY_FLOOR_ACCEPTANCE_LEASE_MS: '2000',
        },
      },
    );
    const marker = '\n{\n  "status": "completed"';
    const markerStart = stdout.lastIndexOf(marker);
    expect(markerStart).toBeGreaterThanOrEqual(0);
    const summary = parseJsonObjectAt(stdout, markerStart + 1) as Record<
      string,
      unknown
    >;
    expect(summary.status).toBe('completed');
    expect(summary.executions).toBe(6);
    expect(summary.completedExecutions).toBe(6);
    expect(summary.failedAttempts).toBe(1);
    expect(summary.abandonedAttempts).toBeGreaterThanOrEqual(1);
    expect(summary.replacementAttempts).toBeGreaterThanOrEqual(1);
    expect(summary.incompleteDeliveries).toEqual([]);
    expect(summary.duplicateOutputs).toEqual([]);
    expect(summary.duplicateDeliveries).toEqual([]);
    expect(summary.staleAttemptCommitted).toBe(false);
    expect(summary.staleResultCode).toBe('inactive_attempt');
    expect(summary.recoveryEvent).toBeTruthy();
    expect(summary.projectionsCaughtUp).toBe(true);
  }, 190_000);
});
