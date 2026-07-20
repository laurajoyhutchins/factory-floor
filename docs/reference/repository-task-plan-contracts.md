# Repository-task plan contracts

Repository-task plan version 1 turns concise authored intent into deterministic, replayable state for bounded repository work. The contracts deliberately stop before planning file operations, applying patches, running commands, or writing to GitHub.

## Four distinct layers

| Layer | Owns | Does not own |
| --- | --- | --- |
| Authored intent | Objective, exact repository revision, allowed paths, recipe selection and inputs, requested outputs, named verification profile, resource bounds, requested capabilities, and completion criteria | Credentials, shell commands, policy decisions, branch creation, commits, comments, pull requests, or merge authority |
| Normalized state | Canonical ordering, normalized prose, canonical recipe inputs, declared outputs, and a stable SHA-256 plan digest | Permission to execute or mutate anything |
| Repository/runtime policy | Supported recipe versions, path restrictions, verification-profile resolution, budgets, capabilities, and external-action approval | Reinterpretation of authored prose after normalization |
| Execution | Side-effect-free planning first, then separately authorized patch proposal and verification stages | Durable runtime commits or direct external writes from the plan or worker payload |

The plan describes intent and bounded inputs. It never grants authority.

## Contracts

- `repository-task-authored-plan.schema.json` is the closed authored JSON shape.
- `repository-task-normalized-plan.schema.json` is canonical retained state.
- `repository-task-recipe-invocation.schema.json` identifies a repository-owned recipe version and its closed typed inputs.
- `repository-task-declared-output.schema.json` describes required proposed content or evidence.
- `repository-task-diagnostic.schema.json` defines stable machine-readable validation and normalization failures.

All contracts use JSON Schema Draft 2020-12 and participate in the existing TypeScript and Python binding-generation pipeline.

## Repository identity

An authored plan names exactly one repository by `owner` and `name` and pins `baseRevision` to a full lowercase 40-character Git commit SHA. Branch names, tags, URLs, and abbreviated revisions are intentionally excluded because they are mutable or ambiguous.

## Recipe boundary

Version 1 supports `typescript-module@1`. Its input object is closed and requires:

- `package`: a scoped package name;
- `moduleName`: a lowercase kebab-case module name.

Unknown recipe inputs are rejected. Commands, scripts, environment variables, credentials, provider configuration, and arbitrary executable payloads cannot be smuggled through recipe inputs.

A later repository profile may add recipe versions, but each version must define its own closed, deterministic input contract.

## Verification boundary

`verificationProfile` is a repository-owned symbolic name such as `package-unit`. The authored plan cannot contain commands, executable scripts, environment variables, or workflow definitions. A later policy-aware planner resolves the profile to repository-approved verification behavior.

## Capabilities

Version 1 recognizes these requested capabilities by default:

- `repository.read`
- `repository.proposePatch`
- `verification.request`

Normalization rejects requests outside the supplied policy capability set. Even accepted requests are not grants; the runtime must record a separate policy decision before dispatch.

GitHub credentials and direct write capabilities are never plan fields or worker inputs. Branch, commit, comment, draft-pull-request, and merge operations must remain separately reconciled external actions.

## Path and resource safety

Every allowed path must be either an exact non-empty repository-relative POSIX path or a path ending in one recursive `/**` glob. Declared output paths must be concrete repository-relative paths and must fall inside at least one authored path constraint.

Normalization rejects:

- absolute paths;
- Windows drive paths or backslashes;
- `..` traversal segments;
- `.git` path segments;
- NUL bytes;
- intermediate or ambiguous glob syntax such as `packages/*/src/**`;
- output globs;
- outputs outside the authored allowed path set.

The declared count of file, test, and export outputs may not exceed `resourceBounds.maxFiles`. Patch-byte and verification-time bounds are retained for later enforcement by the planner and verification runtime.

A safe path and accepted resource request are still only intent. Repository policy may narrow either boundary further.

## Canonical normalization

`normalizeRepositoryTaskPlan()` applies these rules:

1. Validate the authored object as a closed schema.
2. Emit stable sorted diagnostics for schema and semantic failures.
3. Collapse repeated whitespace in the objective and completion criteria.
4. Trim, deduplicate, and code-unit sort allowed paths, requested capabilities, and completion criteria.
5. Canonically order recipe-input object keys.
6. Normalize and code-unit sort declared outputs by name, kind, and path.
7. Construct normalized state without `planDigest`.
8. Recursively code-unit sort object keys, serialize compact JSON, and compute lowercase SHA-256.
9. Attach the digest and validate the complete normalized-plan schema.

Array ordering is normalized only where the contract declares order semantically irrelevant. The current recipe has scalar inputs only; future recipe schemas must explicitly define any order-sensitive arrays.

The canonical minimal fixtures are:

- `contracts/fixtures/repository-task/minimal-authored-plan.valid.json`
- `contracts/fixtures/repository-task/equivalent-authored-plan.valid.json`
- `contracts/fixtures/repository-task/minimal-normalized-plan.valid.json`

The two authored fixtures normalize byte-for-byte to the same normalized fixture and digest.

## Stable diagnostics

The initial diagnostic codes are:

| Code | Meaning |
| --- | --- |
| `schema.unknown-field` | A closed contract received an undeclared field, including arbitrary verification commands, recipe commands, or credential-shaped additions. |
| `schema.invalid` | An authored value failed structural validation. |
| `path.unsafe` | An allowed or output path is not a safe repository-relative path, or an output path contains a glob. |
| `path.unsupported-pattern` | An allowed path uses glob syntax other than a single terminal recursive `/**`. |
| `output.outside-allowed-paths` | A declared output path is not covered by the authored allowed path set. |
| `output.duplicate-name` | Two declared outputs use the same stable name. |
| `resource.max-files-exceeded` | Declared file-like outputs exceed `resourceBounds.maxFiles`. |
| `recipe.unsupported-version` | Repository policy does not support the requested recipe version. |
| `capability.not-allowed` | A requested capability lies outside the supplied policy boundary. |
| `normalized.schema-invalid` | Internal normalization produced state that violates its own contract; this is an implementation defect. |

Diagnostics contain a stable code, severity, JSON Pointer path, and bounded human-readable message. Callers must branch on `code`, not message text.

## Adding a recipe

A new recipe may become selectable only when repository-owned code supplies:

1. a stable recipe name and integer version string;
2. a closed typed input schema and deterministic normalization;
3. declared path and output behavior;
4. focused fixture coverage;
5. an explicit supported-recipe registry entry.

Recipe support does not expand capabilities or external authority.

## Relationship to later work

The next plan-compiler stage may parse Markdown/front matter and produce generation graphs, but it must retain this normalized object and digest unchanged. Patch application, verification execution, artifact retention, and GitHub reconciliation remain later, separately authorized boundaries.
