import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileRepositoryTaskPlan,
  parseRepositoryTaskPlanMarkdown,
  replayRepositoryTaskGenerationGraph,
  serializeRepositoryTaskGenerationGraph,
} from './compile-repository-task-plan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureDirectory = resolve(
  root,
  'contracts/fixtures/repository-task/compiler',
);

function textFixture(name) {
  return readFileSync(resolve(fixtureDirectory, name), 'utf8');
}

function jsonFixture(name) {
  return JSON.parse(textFixture(name));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const minimalMarkdown = textFixture('minimal-plan.valid.md');
const equivalentMarkdown = textFixture('equivalent-plan.valid.md');
const profile = jsonFixture('minimal-repository-profile.valid.json');
const expectedGraph = jsonFixture('minimal-generation-graph.valid.json');

function operationForOutput(
  normalizedPlan,
  profileValue,
  outputName,
  dependsOn = [],
) {
  const outputIndex = normalizedPlan.outputs.findIndex(
    (output) => output.name === outputName,
  );
  const packageIndex = profileValue.packages.findIndex(
    (entry) => entry.name === normalizedPlan.recipe.inputs.package,
  );
  const output = normalizedPlan.outputs[outputIndex];
  return {
    id: `operation:${output.name}`,
    operation: 'create',
    path: output.path,
    outputName: output.name,
    mediaType: output.mediaType,
    dependsOn: [
      'input:normalized-plan',
      'input:repository-profile',
      ...dependsOn,
    ],
    attribution: [
      { kind: 'recipe', reference: `typescript-module@1/${output.name}` },
      { kind: 'profile', reference: `/packages/${packageIndex}` },
      { kind: 'plan', reference: `/outputs/${outputIndex}` },
    ],
  };
}

const recipeResolvers = {
  'typescript-module@1': ({ normalizedPlan, profile: profileValue }) => ({
    operations: [
      operationForOutput(normalizedPlan, profileValue, 'unit-test', [
        'operation:implementation',
      ]),
      operationForOutput(normalizedPlan, profileValue, 'implementation'),
    ],
    conflicts: [],
  }),
};

describe('repository-task Markdown compiler', () => {
  it('parses front matter and produces the stable minimal generation graph', () => {
    const parsed = parseRepositoryTaskPlanMarkdown(minimalMarkdown);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.authoredPlan?.objective).toBe(
      'Add a deterministic utility module.',
    );

    const result = compileRepositoryTaskPlan(minimalMarkdown, {
      profile,
      recipeResolvers,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.generationGraph).toEqual(expectedGraph);
  });

  it('compiles equivalent authored Markdown byte-identically', () => {
    const first = compileRepositoryTaskPlan(minimalMarkdown, {
      profile,
      recipeResolvers,
    });
    const second = compileRepositoryTaskPlan(equivalentMarkdown, {
      profile,
      recipeResolvers,
    });

    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(serializeRepositoryTaskGenerationGraph(second.generationGraph)).toBe(
      serializeRepositoryTaskGenerationGraph(first.generationGraph),
    );
  });

  it.each([
    {
      id: 'missing opening delimiter',
      markdown: 'schemaVersion: 1\n---\nObjective.',
      code: 'markdown.front-matter-required',
    },
    {
      id: 'missing closing delimiter',
      markdown: '---\nschemaVersion: 1\nObjective.',
      code: 'markdown.front-matter-unterminated',
    },
    {
      id: 'duplicate YAML key',
      markdown: '---\nschemaVersion: 1\nschemaVersion: 1\n---\nObjective.',
      code: 'markdown.front-matter-invalid',
    },
    {
      id: 'empty objective',
      markdown: '---\nschemaVersion: 1\n---\n   \n',
      code: 'markdown.objective-required',
    },
  ])('rejects $id with stable structured diagnostics', ({ markdown, code }) => {
    const result = compileRepositoryTaskPlan(markdown, {
      profile,
      recipeResolvers,
    });

    expect(result.generationGraph).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      code,
    );
  });

  it('rejects repository-profile and verification mismatches before resolution', () => {
    const mismatchedRepository = clone(profile);
    mismatchedRepository.repository.name = 'not-factory-floor';
    const repositoryResult = compileRepositoryTaskPlan(minimalMarkdown, {
      profile: mismatchedRepository,
      recipeResolvers,
    });
    expect(repositoryResult.generationGraph).toBeNull();
    expect(repositoryResult.diagnostics.map(({ code }) => code)).toContain(
      'profile.repository-mismatch',
    );

    const unsupportedVerification = clone(profile);
    unsupportedVerification.verificationProfiles = ['static-only'];
    const verificationResult = compileRepositoryTaskPlan(minimalMarkdown, {
      profile: unsupportedVerification,
      recipeResolvers,
    });
    expect(verificationResult.generationGraph).toBeNull();
    expect(verificationResult.diagnostics.map(({ code }) => code)).toContain(
      'profile.verification-profile-unsupported',
    );
  });

  it('rejects conflicting paths without exposing a partial executable graph', () => {
    const conflictingResolvers = {
      'typescript-module@1': ({ normalizedPlan, profile: profileValue }) => ({
        operations: [
          operationForOutput(normalizedPlan, profileValue, 'implementation'),
          {
            ...operationForOutput(normalizedPlan, profileValue, 'unit-test'),
            path: 'packages/example/src/canonical-value.ts',
          },
        ],
        conflicts: [],
      }),
    };

    const result = compileRepositoryTaskPlan(minimalMarkdown, {
      profile,
      recipeResolvers: conflictingResolvers,
    });

    expect(result.generationGraph).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'graph.path-conflict',
          path: '/operations',
        }),
      ]),
    );
  });

  it('rejects missing and cyclic dependencies deterministically', () => {
    const missingDependencyResolvers = {
      'typescript-module@1': ({ normalizedPlan, profile: profileValue }) => ({
        operations: [
          operationForOutput(normalizedPlan, profileValue, 'implementation', [
            'operation:missing',
          ]),
        ],
        conflicts: [],
      }),
    };
    const missing = compileRepositoryTaskPlan(minimalMarkdown, {
      profile,
      recipeResolvers: missingDependencyResolvers,
    });
    expect(missing.generationGraph).toBeNull();
    expect(missing.diagnostics.map(({ code }) => code)).toContain(
      'graph.missing-dependency',
    );

    const cyclicResolvers = {
      'typescript-module@1': ({ normalizedPlan, profile: profileValue }) => ({
        operations: [
          operationForOutput(normalizedPlan, profileValue, 'implementation', [
            'operation:unit-test',
          ]),
          operationForOutput(normalizedPlan, profileValue, 'unit-test', [
            'operation:implementation',
          ]),
        ],
        conflicts: [],
      }),
    };
    const cyclic = compileRepositoryTaskPlan(minimalMarkdown, {
      profile,
      recipeResolvers: cyclicResolvers,
    });
    expect(cyclic.generationGraph).toBeNull();
    expect(cyclic.diagnostics.map(({ code }) => code)).toContain(
      'graph.dependency-cycle',
    );
  });

  it('round-trips retained graph bytes and rejects digest tampering', () => {
    const serialized = serializeRepositoryTaskGenerationGraph(expectedGraph);
    const replayed = replayRepositoryTaskGenerationGraph(serialized);

    expect(replayed.diagnostics).toEqual([]);
    expect(replayed.generationGraph).toEqual(expectedGraph);
    expect(
      serializeRepositoryTaskGenerationGraph(replayed.generationGraph),
    ).toBe(serialized);

    const tampered = JSON.parse(serialized);
    tampered.nodes[2].path = 'packages/example/src/tampered.ts';
    const rejected = replayRepositoryTaskGenerationGraph(
      JSON.stringify(tampered),
    );

    expect(rejected.generationGraph).toBeNull();
    expect(rejected.diagnostics.map(({ code }) => code)).toContain(
      'graph.digest-mismatch',
    );
  });

  it('does not mutate Markdown, profile, or resolver results', () => {
    const profileInput = clone(profile);
    const profileBefore = JSON.stringify(profileInput);
    const markdownBefore = minimalMarkdown;
    const result = compileRepositoryTaskPlan(minimalMarkdown, {
      profile: profileInput,
      recipeResolvers,
    });

    expect(result.diagnostics).toEqual([]);
    expect(minimalMarkdown).toBe(markdownBefore);
    expect(JSON.stringify(profileInput)).toBe(profileBefore);
  });
});
