---
completionCriteria:
  - 'The focused unit test   passes.'
  - The public export is available.
requestedCapabilities:
  - verification.request
  - repository.read
  - repository.proposePatch
resourceBounds:
  { maxVerificationSeconds: 120, maxPatchBytes: 32768, maxFiles: 4 }
verificationProfile: package-unit
outputContract:
  outputs:
    - {
        required: true,
        mediaType: text/typescript,
        path: packages/example/test/canonical-value.test.ts,
        kind: test,
        name: unit-test,
      }
    - {
        path: packages/example/src/canonical-value.ts,
        name: implementation,
        required: true,
        kind: file,
        mediaType: text/typescript,
      }
recipe:
  inputs: { moduleName: canonical-value, package: '@factory-floor/example' }
  version: '1'
  name: typescript-module
allowedPaths:
  - packages/example/package.json
  - packages/example/test/**
  - packages/example/src/**
repository:
  baseRevision: 62c91dc5a033eb2b74b09df3c196d052916ec062
  name: FACTORY-FLOOR
  owner: LauraJoyHutchins
schemaVersion: 1
---

Add a deterministic
utility module.
