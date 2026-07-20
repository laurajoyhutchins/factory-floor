import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const baseline = JSON.parse(read('docs/reference/m1-acceptance-baseline.json'));
const workflow = YAML.parse(
  read('.github/workflows/repository-verification.yml'),
);
const acceptanceScript = read('scripts/accept-m1.sh');

describe('measured Milestone 1 acceptance cadence', () => {
  it('records a source-backed overlap baseline before changing cadence', () => {
    expect(baseline.source.repositoryVerificationRun).toBe(565);
    expect(baseline.seconds.fullCleanAcceptance).toBe(161.878);
    expect(baseline.seconds.canonicalRepeatedTotal).toBe(130.405);
    expect(baseline.duplicatePercentLowerBound).toBeGreaterThan(80);
    expect(baseline.repeatedTests).toBe(348);
    expect(
      baseline.classification.map(({ classification }) => classification),
    ).toEqual(
      expect.arrayContaining([
        'duplicated',
        'clean-environment-specific',
        'recovery-specific',
        'evidence-producing',
      ]),
    );
  });

  it('keeps stable PR jobs while deferring full clean work to trusted cadences', () => {
    const cleanAcceptance = workflow.jobs['m1-acceptance'];
    expect(cleanAcceptance.needs).toBe('service-verification');
    expect(cleanAcceptance.name).toBe('Milestone 1 clean acceptance');
    expect(workflow.jobs['fast-verification']).toBeDefined();
    expect(workflow.jobs['service-verification']).toBeDefined();

    expect(acceptanceScript).toContain(
      '[[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && "${FACTORY_FLOOR_FORCE_CLEAN_ACCEPTANCE:-0}" != "1" ]]',
    );
    expect(acceptanceScript).toContain('deferred_to_trusted_cadence');
    expect(acceptanceScript).toContain(
      'Full clean acceptance runs on main and direct invocation.',
    );
  });

  it('retains every full clean-acceptance guarantee and instruments its phases', () => {
    expect(acceptanceScript).toContain(
      'local output=".factory-floor/ci-metrics/${phase}.json"',
    );
    const phases = [
      'm1-bootstrap',
      'm1-static',
      'm1-unit',
      'm1-services',
      'm1-integration',
      'm1-live-restart',
      'm1-cancellation',
      'm1-investigation-evidence',
      'm1-collect-evidence',
      'm1-conformance-summary',
    ];
    for (const phase of phases) {
      expect(acceptanceScript).toContain(`run_phase ${phase}`);
    }

    for (const retainedGuarantee of [
      'pnpm verify:static',
      'pnpm verify:unit',
      'pnpm verify:services',
      'pnpm verify:integration',
      'pnpm acceptance:m1-live-restart',
      'scripts/run-m1-cancellation-evidence.ts',
      'pnpm demo:investigation',
      'scripts/record-m1-policy-evidence.ts',
      'node scripts/collect-m1-evidence.mjs',
      'pnpm conformance:check',
    ]) {
      expect(acceptanceScript).toContain(retainedGuarantee);
    }
  });
});
