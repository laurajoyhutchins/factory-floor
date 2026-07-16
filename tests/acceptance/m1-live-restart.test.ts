import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

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
    const jsonStart = stdout.lastIndexOf('\n{\n  "status": "completed"');
    const summary = JSON.parse(stdout.slice(jsonStart + 1));
    expect(summary.executions).toBe(6);
    expect(summary.completedExecutions).toBe(6);
    expect(summary.failedAttempts).toBe(1);
    expect(summary.abandonedAttempts).toBeGreaterThanOrEqual(1);
    expect(summary.replacementAttempts).toBeGreaterThanOrEqual(1);
    expect(summary.duplicateOutputs).toEqual([]);
    expect(summary.duplicateDeliveries).toEqual([]);
    expect(summary.staleAttemptCommitted).toBe(false);
    expect(summary.recoveryEvent).toBeTruthy();
    expect(summary.projectionsCaughtUp).toBe(true);
  }, 190_000);
});
