import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '../src/declarations/canonical-json.js';
import {
  executeRepositoryTaskGraph,
  type RepositoryTaskExecutionInput,
  type RepositoryTaskVerificationProfiles,
} from '../src/repository-task/apply-verify-service.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const indexPath = 'packages/example/src/index.ts';
const sourcePath = 'packages/example/src/generated-value.ts';
const testPath = 'packages/example/test/generated-value.test.ts';
const originalIndex = 'export const EXISTING = true;\n';
const source = "export const GENERATED_VALUE = 'factory-floor';\n";
const test = `import { describe, expect, it } from 'vitest';
import { GENERATED_VALUE } from '../src/generated-value.js';

describe('GENERATED_VALUE', () => {
  it('is deterministic', () => {
    expect(GENERATED_VALUE).toBe('factory-floor');
  });
});
`;
const publicExport = "export * from './generated-value.js';\n";

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withDigest<T extends Record<string, unknown>>(
  value: T,
  key: 'planDigest' | 'graphDigest',
): T & Record<typeof key, string> {
  return { ...value, [key]: canonicalJsonDigest(value) };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const verificationProfiles: RepositoryTaskVerificationProfiles = {
  fixture: {
    stages: [
      {
        id: 'format',
        executable: process.execPath,
        args: ['-e', "process.stdout.write('format ok\\n')"],
        timeoutMs: 1_000,
      },
      {
        id: 'focused-test',
        executable: process.execPath,
        args: [
          '-e',
          `const fs = require('node:fs');
const source = fs.readFileSync(${JSON.stringify(sourcePath)}, 'utf8');
const test = fs.readFileSync(${JSON.stringify(testPath)}, 'utf8');
if (!source.includes('GENERATED_VALUE')) process.exit(7);
if (!test.includes('is deterministic')) process.exit(8);`,
        ],
        timeoutMs: 1_000,
      },
    ],
  },
};

interface Fixture {
  root: string;
  input: RepositoryTaskExecutionInput;
}

async function fixture(conflict = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ff-apply-verify-'));
  roots.push(root);
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'factory-floor@example.invalid');
  await git(root, 'config', 'user.name', 'Factory Floor Test');
  await mkdir(join(root, 'packages/example/src'), { recursive: true });
  await mkdir(join(root, 'packages/example/test'), { recursive: true });
  await writeFile(join(root, indexPath), originalIndex, 'utf8');
  await writeFile(
    join(root, 'package.json'),
    '{"name":"fixture","private":true}\n',
    'utf8',
  );
  if (conflict) {
    await writeFile(
      join(root, sourcePath),
      "export const GENERATED_VALUE = 'conflict';\n",
      'utf8',
    );
  }
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'fixture base');
  const baseRevision = await git(root, 'rev-parse', 'HEAD');
  const plan = withDigest(
    {
      schemaVersion: 1,
      objective: 'Apply and verify a deterministic TypeScript module.',
      repository: {
        owner: 'laurajoyhutchins',
        name: 'factory-floor',
        baseRevision,
      },
      allowedPaths: [indexPath, sourcePath, testPath],
      recipe: {
        name: 'typescript-module',
        version: '1',
        inputs: {
          package: '@factory-floor/example',
          moduleName: 'generated-value',
        },
      },
      outputs: [
        {
          name: 'implementation',
          kind: 'file',
          path: sourcePath,
          mediaType: 'text/typescript',
          required: true,
        },
        {
          name: 'public-export',
          kind: 'export',
          path: indexPath,
          mediaType: 'text/typescript',
          required: true,
        },
        {
          name: 'unit-test',
          kind: 'test',
          path: testPath,
          mediaType: 'text/typescript',
          required: true,
        },
      ],
      verificationProfile: 'fixture',
      resourceBounds: {
        maxFiles: 3,
        maxPatchBytes: 32_768,
        maxVerificationSeconds: 10,
      },
      requestedCapabilities: [
        'repository.proposePatch',
        'repository.read',
        'verification.request',
      ],
      completionCriteria: [
        'The module is publicly exported.',
        'The focused test passes.',
      ],
    },
    'planDigest',
  );
  const profile = {
    schemaVersion: 1,
    repository: { owner: 'laurajoyhutchins', name: 'factory-floor' },
    pathBoundaries: ['packages/example/**'],
    recipes: { 'typescript-module': ['1'] },
    verificationProfiles: ['fixture'],
    packages: [
      {
        name: '@factory-floor/example',
        path: 'packages/example',
        sourceDirectory: 'src',
        testDirectory: 'test',
        publicExportPath: 'src/index.ts',
      },
    ],
  };
  const profileDigest = canonicalJsonDigest(profile);
  const operations = [
    {
      id: 'operation:implementation',
      operation: 'create',
      path: sourcePath,
      outputName: 'implementation',
      content: source,
      contentDigest: sha256(source),
      dependsOn: [],
    },
    {
      id: 'operation:public-export',
      operation: 'update',
      path: indexPath,
      outputName: 'public-export',
      content: `${originalIndex}${publicExport}`,
      contentDigest: sha256(`${originalIndex}${publicExport}`),
      expectedDigest: sha256(originalIndex),
      dependsOn: ['operation:implementation'],
    },
    {
      id: 'operation:unit-test',
      operation: 'create',
      path: testPath,
      outputName: 'unit-test',
      content: test,
      contentDigest: sha256(test),
      dependsOn: ['operation:implementation'],
    },
  ].map((operation, index) => ({
    ...operation,
    kind: 'file-operation',
    mediaType: 'text/typescript',
    dependsOn: [
      'input:normalized-plan',
      'input:repository-profile',
      ...operation.dependsOn,
    ],
    attribution: [
      { kind: 'plan', reference: `/outputs/${index}` },
      { kind: 'profile', reference: '/packages/0' },
      {
        kind: 'recipe',
        reference: `typescript-module@1/${operation.outputName}`,
      },
    ],
  }));
  const graph = withDigest(
    {
      schemaVersion: 1,
      planDigest: plan.planDigest,
      profileDigest,
      repository: plan.repository,
      recipe: { name: 'typescript-module', version: '1' },
      verificationProfile: 'fixture',
      nodes: [
        {
          id: 'input:normalized-plan',
          kind: 'input',
          inputKind: 'normalized-plan',
          digest: plan.planDigest,
          dependsOn: [],
        },
        {
          id: 'input:repository-profile',
          kind: 'input',
          inputKind: 'repository-profile',
          digest: profileDigest,
          dependsOn: [],
        },
        ...operations,
      ],
      outputs: plan.outputs.map((output, index) => ({
        name: output.name,
        kind: output.kind,
        path: output.path,
        nodeId: operations[index]?.id,
      })),
      conflicts: [],
    },
    'graphDigest',
  );
  return {
    root,
    input: {
      repositoryRoot: root,
      normalizedPlan: plan,
      repositoryProfile: profile,
      generationGraph: graph,
      verificationProfiles,
    },
  };
}

function mutatePlan(
  input: RepositoryTaskExecutionInput,
  mutation: (plan: Record<string, unknown>) => void,
): RepositoryTaskExecutionInput {
  const next = clone(input);
  const plan = next.normalizedPlan as Record<string, unknown>;
  delete plan.planDigest;
  mutation(plan);
  next.normalizedPlan = withDigest(plan, 'planDigest');
  return mutateGraph(next, (graph) => {
    graph.planDigest = next.normalizedPlan.planDigest;
    graph.repository = clone(next.normalizedPlan.repository);
    graph.verificationProfile = next.normalizedPlan.verificationProfile;
    const nodes = graph.nodes as Array<Record<string, unknown>>;
    const node = nodes.find((candidate) => {
      return candidate.id === 'input:normalized-plan';
    });
    if (node) node.digest = next.normalizedPlan.planDigest;
  });
}

function mutateGraph(
  input: RepositoryTaskExecutionInput,
  mutation: (graph: Record<string, unknown>) => void,
): RepositoryTaskExecutionInput {
  const next = clone(input);
  const graph = next.generationGraph as Record<string, unknown>;
  delete graph.graphDigest;
  mutation(graph);
  next.generationGraph = withDigest(graph, 'graphDigest');
  return next;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => {
      return rm(root, { recursive: true, force: true });
    }),
  );
});

describe('executeRepositoryTaskGraph', () => {
  it('dry-runs, applies in isolation, verifies, and retries identically', async () => {
    const value = await fixture();
    const dryRun = await executeRepositoryTaskGraph({
      ...value.input,
      dryRun: true,
    });
    expect(dryRun.status).toBe('dry-run');
    expect(dryRun.evidence.mutations.map(({ path }) => path)).toEqual([
      sourcePath,
      indexPath,
      testPath,
    ]);
    expect(await exists(join(value.root, sourcePath))).toBe(false);

    const first = await executeRepositoryTaskGraph(value.input);
    const second = await executeRepositoryTaskGraph(value.input);
    expect(first.status).toBe('succeeded');
    expect(first.evidence.verification).toEqual([
      expect.objectContaining({ stageId: 'format', status: 'succeeded' }),
      expect.objectContaining({
        stageId: 'focused-test',
        status: 'succeeded',
      }),
    ]);
    expect(first.patch).toContain(sourcePath);
    expect(first.evidence.patchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidence.treeDigest).toMatch(/^[a-f0-9]{40,64}$/);
    expect(second.evidence.evidenceId).toBe(first.evidence.evidenceId);
    expect(await exists(join(value.root, sourcePath))).toBe(false);
    expect(await readFile(join(value.root, indexPath), 'utf8')).toBe(
      originalIndex,
    );
  });

  it('fails closed for base drift, path escape, conflict, and policy gaps', async () => {
    const value = await fixture();
    const unavailable = mutatePlan(value.input, (plan) => {
      const repository = plan.repository as Record<string, unknown>;
      repository.baseRevision = 'f'.repeat(40);
    });
    await expect(
      executeRepositoryTaskGraph(unavailable),
    ).resolves.toMatchObject({
      status: 'failed',
      evidence: { diagnostics: [{ code: 'executor.base-unavailable' }] },
    });

    const escaped = mutateGraph(value.input, (graph) => {
      const nodes = graph.nodes as Array<Record<string, unknown>>;
      const operation = nodes.find((candidate) => {
        return candidate.id === 'operation:implementation';
      });
      if (operation) operation.path = '../escaped.ts';
    });
    await expect(executeRepositoryTaskGraph(escaped)).resolves.toMatchObject({
      status: 'failed',
      evidence: { diagnostics: [{ code: 'executor.path-unsafe' }] },
    });

    const conflicting = await fixture(true);
    await expect(
      executeRepositoryTaskGraph(conflicting.input),
    ).resolves.toMatchObject({
      status: 'failed',
      evidence: { diagnostics: [{ code: 'executor.create-conflict' }] },
    });

    const missingPolicy = mutatePlan(value.input, (plan) => {
      plan.verificationProfile = 'missing';
    });
    await expect(
      executeRepositoryTaskGraph(missingPolicy),
    ).resolves.toMatchObject({
      status: 'failed',
      evidence: {
        diagnostics: [{ code: 'verification.profile-unavailable' }],
      },
    });
  });

  it('retains verifier failures, timeouts, and redacted bounded logs', async () => {
    const value = await fixture();
    const failed = await executeRepositoryTaskGraph({
      ...value.input,
      verificationProfiles: {
        fixture: {
          stages: [
            {
              id: 'test',
              executable: process.execPath,
              args: ['-e', 'process.exit(2)'],
              timeoutMs: 1_000,
            },
          ],
        },
      },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      evidence: {
        diagnostics: [{ code: 'verification.failed' }],
        verification: [{ stageId: 'test', status: 'failed', exitCode: 2 }],
      },
    });

    const timedOut = await executeRepositoryTaskGraph({
      ...value.input,
      verificationProfiles: {
        fixture: {
          stages: [
            {
              id: 'test',
              executable: process.execPath,
              args: ['-e', 'setTimeout(() => undefined, 5_000)'],
              timeoutMs: 10,
            },
          ],
        },
      },
    });
    expect(timedOut).toMatchObject({
      status: 'failed',
      evidence: {
        diagnostics: [{ code: 'verification.timeout' }],
        verification: [{ stageId: 'test', status: 'timed-out' }],
      },
    });

    const bounded = await executeRepositoryTaskGraph({
      ...value.input,
      maxLogBytes: 64,
      verificationProfiles: {
        fixture: {
          stages: [
            {
              id: 'test',
              executable: process.execPath,
              args: [
                '-e',
                "process.stdout.write('Bearer secret-token\\n' + 'x'.repeat(200))",
              ],
              timeoutMs: 1_000,
            },
          ],
        },
      },
    });
    const stdout = bounded.evidence.verification[0]?.stdout ?? '';
    expect(bounded.status).toBe('succeeded');
    expect(stdout).toContain('[REDACTED]');
    expect(stdout).not.toContain('secret-token');
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(64);
  });
});
