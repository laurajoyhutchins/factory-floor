# Operator console model

**Type:** Explanation
**Status:** Current product direction for the v0.1 console

The Factory Floor console is an inspection surface for a durable runtime. It should make flow, bottlenecks, constraints, attempts, artifacts, and human intervention legible without turning the runtime into a game skin or a prompt-node editor.

## Three levels of understanding

The console moves from system-scale context to forensic detail:

```text
Installation
  → stable regions and system health
Region
  → local topology, work, constraints, and outputs
Execution or artifact
  → causation, attempts, content, policy, and provenance
```

At the installation level, an operator asks what is active, waiting, blocked, consuming resources, or requiring human action. At the region level, the operator follows bounded mechanisms, fan-out, fan-in, and output contracts. At the execution or artifact level, the operator reconstructs durable causation and lineage.

## Visual language

The factory metaphor is useful when it maps to runtime facts:

- machines represent component instances;
- work cells represent regions;
- lines represent connections;
- workpieces represent artifact references;
- pulses represent sampled deliveries or durable events;
- machine activity represents active executions;
- badges summarize completed work cells.

Animation is explanatory, not decorative. Every movement must correspond to a durable event, delivery, execution transition, or committed artifact. Status must never depend on color alone, and reduced-motion preferences replace moving pulses with static direction markers.

## Inspection and intervention

The first console is read-mostly. It exposes topology, executions, traces, artifacts, resources, policy decisions, projections, approvals, and alerts through supported control-plane APIs. It does not author arbitrary visual graphs or mutate runtime state from the inspection surface.

Intervention points should be surfaced as meaningful queues: approval required, clarification requested, blocked work, repeated failure, conflicting results, low confidence, budget pressure, irreversible action ready, and dead-lettered work.

An approval view should show the proposed action, requested capability, relevant artifacts, predicted effect, policy reason, and alternatives. An artifact view should show schema, digest, size, creator, producing execution, causing event, derivations, consumers, policy decisions, sensitivity, retention, validation, and trust indicators.

## Deferred product scope

Free-form drag-and-drop authoring, multiplayer presence, blueprint marketplaces, 3D rendering, game mechanics unrelated to operations, and personality avatars remain outside the v0.1 console. Dynamic child-region construction is also outside the static Milestone 1 runtime.

Use the [operator-console how-to guide](../how-to/inspect-with-operator-console.md) for local operation and the [runtime contract reference](../reference/runtime-contract.md) for the precise semantics exposed by the UI.
