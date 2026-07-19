# Factory Floor documentation

This directory contains the authoritative, reader-facing documentation for Factory Floor. It is organized by reader intent using the Diátaxis model.

## How to use these docs

- **How-to guides** help an operator or developer complete a task.
- **Reference** pages define stable terms, contracts, protocol behavior, conformance requirements, and accepted evidence.
- **Explanations** describe the architecture, tradeoffs, and product model.
- **Tutorials** will provide linear beginner walkthroughs when the project has a stable learning path. No tutorial is currently published.

## Current documentation

### How-to

- [Set up a reproducible development environment](how-to/development-environment.md)
- [Run and inspect the investigation](how-to/run-investigation.md)
- [Inspect the runtime with the operator console](how-to/inspect-with-operator-console.md)

### Reference

- [Runtime contract reference v0.1](reference/runtime-contract.md)
- [Runtime terminology glossary](reference/glossary.md)
- [Worker HTTP protocol v1](reference/worker-protocol-v1.md)
- [Operator HTTP API v1](reference/operator-http-api-v1.md)
- [Template instantiation protocol v1](reference/template-instantiation-protocol-v1.md)
- [Durable Reactive Graph conformance ledger](reference/conformance-ledger.yaml)
- [Milestone 1 acceptance evidence](reference/acceptance/m1-durable-reactive-graph.md)

### Explanation

- [Architecture](explanation/architecture.md)
- [Architecture decisions](explanation/architecture-decisions.md)
- [Operator console model](explanation/operator-console.md)
- [Discord Activity operator interface](explanation/discord-activity-operator-interface.md)

## Authority and status

- The runtime contract, architecture decisions, worker protocol, operator API, template-instantiation protocol, and conformance ledger are current normative references.
- The acceptance evidence is a frozen historical record for the released v0.1.0 baseline.
- Product and architecture explanations describe intent and rationale; they do not override the normative reference pages.
- Implementation plans, agent scratch work, and task handoffs do not belong in `docs/`. They are retained in Git history or task-specific tooling instead.
