# Changelog

All notable changes to Factory Floor are documented in this file.

## [Unreleased]

## [0.1.0] - 2026-07-16

### Added

- Durable PostgreSQL-backed command, event, delivery, execution, attempt, artifact, policy, resource, and projection model.
- Immutable filesystem and S3-compatible artifact staging, publication, provenance, tombstoning, and reconciliation.
- Versioned worker HTTP protocol with TypeScript and Python SDKs and deterministic demo workers.
- Atomic execution-result commit pipeline with lifecycle fencing, retries, dead-lettering, and external-action proposals.
- End-to-end investigation example with deliberate verifier failure and durable recovery.
- Operator inspection APIs and CLI views for topology, runtime state, traces, lineage, resources, policies, and projections.
- Startup recovery, cancellation fencing, projection replay, SSE cursors, conformance validation, and retained acceptance evidence.

### Changed

- Cleared repository-wide formatting drift and added permanent formatting, lint, editor, and line-ending guardrails.
- Closed the Milestone 1 implementation plan and established `pnpm accept:m1` as the canonical acceptance command.

### Verified

- Repository Verification #314 passed ordinary verification and the separate clean-checkout Milestone 1 acceptance job.
- Canonical retained artifact: `m1-acceptance-evidence-314`, digest `sha256:6a837091662bb3fb02222b20a5f8dd9a89cb9c21a1b6e145086fe401a793ffa3`.

[Unreleased]: https://github.com/laurajoyhutchins/factory-floor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/laurajoyhutchins/factory-floor/releases/tag/v0.1.0
