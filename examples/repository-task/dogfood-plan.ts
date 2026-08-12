const DOGFOOD_REVISION_TAG_LENGTH = 12;

export interface RepositoryTaskDogfoodTarget {
  revisionTag: string;
  moduleName: string;
  exportName: string;
  typeName: string;
  implementationPath: string;
  testPath: string;
}

export function dogfoodPlanTarget(
  baseRevision: string,
): RepositoryTaskDogfoodTarget {
  const revisionTag = baseRevision
    .slice(0, DOGFOOD_REVISION_TAG_LENGTH)
    .toLowerCase();
  const revisionSymbol = revisionTag.toUpperCase();
  const moduleName = `repository-task-worker-component-${revisionTag}`;

  return {
    revisionTag,
    moduleName,
    exportName: `REPOSITORY_TASK_WORKER_COMPONENT_${revisionSymbol}`,
    typeName: `RepositoryTaskWorkerComponent${revisionTag}`,
    implementationPath: `workers/repository-task-ts/src/${moduleName}.ts`,
    testPath: `workers/repository-task-ts/test/${moduleName}.test.ts`,
  };
}

export function authoredPlan(baseRevision: string): string {
  const target = dogfoodPlanTarget(baseRevision);

  return `---
schemaVersion: 1
repository:
  owner: laurajoyhutchins
  name: factory-floor
  baseRevision: ${baseRevision}
allowedPaths:
  - ${target.implementationPath}
  - ${target.testPath}
  - workers/repository-task-ts/src/index.ts
recipe:
  name: typescript-module
  version: '1'
  inputs:
    package: '@factory-floor/repository-task-worker'
    moduleName: ${target.moduleName}
    responsibility: Describe the bounded durable worker that compiles, applies, verifies, and retains repository-task evidence.
    exports:
      - name: ${target.exportName}
        typeName: ${target.typeName}
        value:
          capabilities:
            - apply-isolated-patch
            - compile-authored-plan
            - retain-evidence
            - run-trusted-verification
          name: repository-task-worker
          responsibility: Describe the bounded durable worker that compiles, applies, verifies, and retains repository-task evidence.
    testCases:
      - name: describes the bounded durable repository-task worker
        exportName: ${target.exportName}
        expected:
          capabilities:
            - apply-isolated-patch
            - compile-authored-plan
            - retain-evidence
            - run-trusted-verification
          name: repository-task-worker
          responsibility: Describe the bounded durable worker that compiles, applies, verifies, and retains repository-task evidence.
outputContract:
  outputs:
    - name: implementation
      kind: file
      path: ${target.implementationPath}
      mediaType: text/typescript
      required: true
    - name: public-export
      kind: export
      path: workers/repository-task-ts/src/index.ts
      mediaType: text/typescript
      required: true
    - name: unit-test
      kind: test
      path: ${target.testPath}
      mediaType: text/typescript
      required: true
verificationProfile: factory-floor
resourceBounds:
  maxFiles: 3
  maxPatchBytes: 131072
  maxVerificationSeconds: 600
requestedCapabilities:
  - repository.read
  - repository.proposePatch
  - verification.request
completionCriteria:
  - The revision-scoped worker component descriptor is publicly exported.
  - The generated unit test passes.
  - The retained patch and verification evidence agree.
---

Add the revision-scoped retained repository-task worker component descriptor through Factory Floor itself.
`;
}
