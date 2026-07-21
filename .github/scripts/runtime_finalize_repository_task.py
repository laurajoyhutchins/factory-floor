from pathlib import Path
import re
from textwrap import dedent


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


source = Path("workers/repository-task-ts/src/index.ts")
text = source.read_text()
pattern = re.compile(
    r"(?P<i>\s*)normalizedPlan: compiled\.normalizedPlan,\n"
    r"(?P=i)generationGraph: compiled\.generationGraph,\n"
    r"(?P=i)patch: \{ patch: '', patchDigest: null \},\n"
    r"(?P=i)evidence:\n"
    r"(?P=i)  repositoryIdentity === undefined\n"
    r"(?P=i)    \? null\n"
    r"(?P=i)    : \{ repositoryIdentity, diagnostics \},"
)
match = pattern.search(text)
if match is None:
    raise SystemExit("failure artifact source block not found")
indent = match.group("i")
replacement = "\n".join(
    [
        f"{indent}normalizedPlan: compiled.normalizedPlan ?? {{",
        f"{indent}  status: 'unavailable',",
        f"{indent}  phase,",
        f"{indent}  artifact: 'normalized-plan',",
        f"{indent}  diagnostics,",
        f"{indent}}},",
        f"{indent}generationGraph: compiled.generationGraph ?? {{",
        f"{indent}  status: 'unavailable',",
        f"{indent}  phase,",
        f"{indent}  artifact: 'generation-graph',",
        f"{indent}  diagnostics,",
        f"{indent}}},",
        f"{indent}patch: {{ patch: '', patchDigest: null }},",
        f"{indent}evidence:",
        f"{indent}  repositoryIdentity === undefined",
        f"{indent}    ? {{",
        f"{indent}        status: 'unavailable',",
        f"{indent}        phase,",
        f"{indent}        artifact: 'evidence',",
        f"{indent}        diagnostics,",
        f"{indent}      }}",
        f"{indent}    : {{ repositoryIdentity, diagnostics }},",
    ]
)
source.write_text(text[: match.start()] + replacement + text[match.end() :])


tests = Path("workers/repository-task-ts/test/index.test.ts")
text = tests.read_text()
pattern = re.compile(
    r"(?P<i>\s*)expect\(workerContext\.staged\.at\(-1\)\?\.value\)\.toMatchObject\(\{\n"
    r"(?P=i)  status: 'failed',\n"
    r"(?P=i)  diagnostics: \[\{ code: 'markdown\.invalid' \}\],\n"
    r"(?P=i)\}\);"
)
match = pattern.search(text)
if match is None:
    raise SystemExit("failure artifact test anchor not found")
indent = match.group("i")
addition = "\n".join(
    [
        match.group(0),
        f"{indent}expect(",
        f"{indent}  workerContext.staged.find(",
        f"{indent}    ({{ portName }}) => portName === 'normalized-plan',",
        f"{indent}  )?.value,",
        f"{indent}).toMatchObject({{ status: 'unavailable', artifact: 'normalized-plan' }});",
        f"{indent}expect(",
        f"{indent}  workerContext.staged.find(",
        f"{indent}    ({{ portName }}) => portName === 'generation-graph',",
        f"{indent}  )?.value,",
        f"{indent}).toMatchObject({{ status: 'unavailable', artifact: 'generation-graph' }});",
        f"{indent}expect(",
        f"{indent}  workerContext.staged.find(({{ portName }}) => portName === 'evidence')",
        f"{indent}    ?.value,",
        f"{indent}).toMatchObject({{ status: 'unavailable', artifact: 'evidence' }});",
    ]
)
tests.write_text(text[: match.start()] + addition + text[match.end() :])


dogfood = Path("examples/repository-task/run-dogfood.ts")
text = dogfood.read_text()
text = replace_once(
    text,
    "function authoredPlan(baseRevision: string): string {",
    dedent(
        """\
        function repositoryIdentity(
          baseRevision: string,
          snapshot: { files: Record<string, string> },
        ) {
          const canonicalFiles = Object.keys(snapshot.files)
            .sort()
            .map((path) => [path, snapshot.files[path]] as const);
          return {
            repository: { owner: 'laurajoyhutchins', name: 'factory-floor' },
            baseRevision,
            snapshotDigest: sha256(JSON.stringify(canonicalFiles)),
            dirtyStatePolicy: 'require-clean' as const,
          };
        }

        function authoredPlan(baseRevision: string): string {"""
    ),
    "repository identity helper",
)
pattern = re.compile(
    r"async function outputArtifacts\([\s\S]*?\n}\n\nasync function writeJson\("
)
match = pattern.search(text)
if match is None:
    raise SystemExit("output artifact reader block not found")
replacement = dedent(
    """\
    async function readCommittedJson(
      blobStore: FilesystemArtifactBlobStore,
      digest: string,
    ): Promise<any> {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          return JSON.parse(
            await streamText(await blobStore.readCommitted(digest)),
          );
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (code !== 'not_found' || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }

    async function outputArtifacts(
      blobStore: FilesystemArtifactBlobStore,
      state: Awaited<ReturnType<typeof runState>>,
    ): Promise<Record<string, any>> {
      return Object.fromEntries(
        await Promise.all(
          state.outputs.map(async (output) => [
            output.port_name,
            await readCommittedJson(blobStore, output.digest),
          ]),
        ),
      );
    }

    async function writeJson("""
)
text = text[: match.start()] + replacement + text[match.end() :]
text = replace_once(
    text,
    "    const snapshot = await repositorySnapshot();\n    const profile = repositoryProfile();",
    "    const snapshot = await repositorySnapshot();\n    const identity = repositoryIdentity(baseRevision, snapshot);\n    const profile = repositoryProfile();",
    "identity setup",
)
text = replace_once(
    text,
    "        repositorySnapshot: snapshot,\n      },\n      idempotencyKey: `repository-task-success-${baseRevision}`",
    "        repositorySnapshot: snapshot,\n        repositoryIdentity: identity,\n      },\n      idempotencyKey: `repository-task-success-${baseRevision}`",
    "success identity",
)
text = replace_once(
    text,
    "        repositorySnapshot: snapshot,\n      },\n      idempotencyKey: `repository-task-failure-${baseRevision}`",
    "        repositorySnapshot: snapshot,\n        repositoryIdentity: repositoryIdentity(unavailableRevision, snapshot),\n      },\n      idempotencyKey: `repository-task-failure-${baseRevision}`",
    "failure identity",
)
text = replace_once(
    text,
    "failureCode !== 'executor.base-unavailable'",
    "failureCode !== 'worker.repository-identity-mismatch'",
    "failure diagnostic",
)
identity_check_anchor = """    if (
      !Array.isArray(successEvidence.verification) ||"""
identity_check = """    if (
      successEvidence.repositoryIdentity?.beforeExecution?.baseRevision !==
        baseRevision ||
      successEvidence.repositoryIdentity?.afterExecution?.baseRevision !==
        baseRevision
    ) {
      throw new Error('retained evidence does not match submitted repository identity');
    }
    if (
      !Array.isArray(successEvidence.verification) ||"""
text = replace_once(
    text,
    identity_check_anchor,
    identity_check,
    "retained identity assertion",
)
dogfood.write_text(text)


normal_workflow = dedent(
    """\
    name: Repository Task Dogfood

    on:
      pull_request:
        paths:
          - '.github/workflows/repository-task-dogfood.yml'
          - 'apps/control-plane/**'
          - 'contracts/**'
          - 'examples/repository-task/**'
          - 'package.json'
          - 'packages/artifact-store/**'
          - 'packages/db/**'
          - 'packages/runtime-core/**'
          - 'packages/worker-sdk-ts/**'
          - 'pnpm-lock.yaml'
          - 'scripts/compile-repository-task-plan.mjs'
          - 'scripts/compile-typescript-module-recipe-plan.mjs'
          - 'scripts/normalize-repository-task-plan.mjs'
          - 'scripts/resolve-typescript-module-recipe.mjs'
          - 'workers/repository-task-ts/**'
      push:
        branches:
          - main
        paths:
          - '.github/workflows/repository-task-dogfood.yml'
          - 'apps/control-plane/**'
          - 'contracts/**'
          - 'examples/repository-task/**'
          - 'package.json'
          - 'packages/artifact-store/**'
          - 'packages/db/**'
          - 'packages/runtime-core/**'
          - 'packages/worker-sdk-ts/**'
          - 'pnpm-lock.yaml'
          - 'scripts/compile-repository-task-plan.mjs'
          - 'scripts/compile-typescript-module-recipe-plan.mjs'
          - 'scripts/normalize-repository-task-plan.mjs'
          - 'scripts/resolve-typescript-module-recipe.mjs'
          - 'workers/repository-task-ts/**'

    permissions:
      contents: read

    concurrency:
      group: repository-task-dogfood-${{ github.ref }}
      cancel-in-progress: true

    env:
      DATABASE_URL: postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor
      TEST_DATABASE_URL: postgres://factory_floor:factory_floor_dev_password@127.0.0.1:5432/factory_floor
      FACTORY_FLOOR_WORKER_TOKEN: factory_floor_repository_task_worker_token
      WORKER_API_BEARER_TOKEN: factory_floor_repository_task_worker_token
      FACTORY_FLOOR_WORKER_ID: repository-task-dogfood-worker
      FACTORY_FLOOR_WORKER_COMPONENT_SELECTORS: repository-task@1
      WORKER_AUTHORIZATION_JSON: '{"repository-task-dogfood-worker":{"token":"factory_floor_repository_task_worker_token","capabilities":["repository-task@1"]}}'

    jobs:
      dogfood:
        runs-on: ubuntu-latest
        timeout-minutes: 30
        steps:
          - name: Check out repository
            uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5

          - name: Set up Node.js
            uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
            with:
              node-version: '22'

          - name: Set up Python
            uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065
            with:
              python-version: '3.12'

          - name: Bootstrap workspace
            run: bash scripts/bootstrap-workspace.sh

          - name: Build workspace runtime
            run: pnpm build:production

          - name: Start durable services
            run: pnpm verify:services

          - name: Run genuine repository-task dogfood
            run: |
              set -o pipefail
              pnpm demo:repository-task 2>&1 | tee repository-task-dogfood.log

          - name: Upload repository-task proof bundle
            if: always()
            uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
            with:
              name: repository-task-dogfood-${{ github.run_number }}
              path: |
                .factory-floor/repository-task-dogfood/
                examples/repository-task/run-dogfood.ts
                repository-task-dogfood.log
              if-no-files-found: error
              include-hidden-files: true
              retention-days: 30

          - name: Stop durable services
            if: always()
            run: pnpm services:clean
    """
)
Path(".github/workflows/repository-task-dogfood.yml").write_text(normal_workflow)
Path(".github/workflows/runtime-finalize-repository-task-dogfood.yml").unlink(
    missing_ok=True
)
Path(".github/workflows/runtime-one-shot-dogfood-patch.yml").unlink(missing_ok=True)
Path(__file__).unlink()
