# Factory Floor Operator Console Brief v0.1

**Status:** Product direction for the first console  
**Primary user:** Runtime operator or system developer  
**Secondary user:** Approver or incident investigator

## 1. Product idea

Factory Floor should feel like a factory management interface for information work.

It borrows:

- **Factorio’s system-scale legibility:** flow, throughput, congestion, resource constraints, persistent geography, and bottlenecks;
- **Opus Magnum’s local mechanism legibility:** small bounded machines, visible artifacts, cycle-by-cycle playback, fan-out, fan-in, and multiple valid constructions.

It must not become a novelty game skin or a prompt-node editor.

## 2. First release scope

The first console is read-mostly. It supports inspection and intervention, not arbitrary visual graph authoring.

Required views:

1. **Factory Floor** — installation and stable-region overview.
2. **Work Cell** — one region’s bounded mechanism and current execution.
3. **Trace & Artifact Inspector** — time, causation, attempts, policies, and lineage.
4. **Approvals & Alerts** — actionable human intervention queue.

## 3. Factory Floor view

### Purpose

Answer, at a glance:

- What is active?
- What is waiting?
- Where is the bottleneck?
- What is consuming resources?
- Which dynamic regions exist?
- Where is human action required?

### Layout

- Top bar: system, environment, health, current cost, budget.
- Left rail: stable regions and dynamic-region list.
- Main canvas: stable outer graph and attached work cells.
- Right inspector: selected region details.
- Bottom rail: timeline, approvals, and alerts.

### Visual encoding

- Connection thickness: queue depth or recent throughput, switchable.
- Moving pulses: event deliveries, sampled rather than one pulse per event at high volume.
- Machine glow: active execution.
- Dashed machine border: blocked.
- Amber: approaching budget or quality threshold.
- Red: failed, denied, or deadline breached.
- Collapsed completed work cell: summary badge with outputs, duration, cost, and status.

Stable regions remain spatially anchored. Dynamic regions unfold from their parent and collapse after completion.

## 4. Work Cell view

### Purpose

Make a bounded region understandable as an operating mechanism.

### Required elements

- objective and output contract at opposite ends;
- component instances as machines with explicit input and output ports;
- artifacts as selectable tokens or cards on connections;
- fan-out and fan-in visible as real branches and joins;
- step playback controls;
- selected component inspector;
- budget, capability, and constraint summary;
- event trace synchronized with the visual mechanism.

### Playback modes

- Live
- Pause
- Step one event
- Step one execution transition
- Replay historical trace
- Speed: 0.5x, 1x, 4x, 20x

Animation is explanatory, not decorative. Every movement corresponds to a durable event, delivery, execution, or committed artifact.

## 5. Trace & Artifact Inspector

### Trace panel

Show:

- accepted command;
- region creation;
- delivery routing;
- attempts and retries;
- failures;
- supervisor decisions;
- policy decisions;
- completion or cancellation.

A timeline scrubber reconstructs the effective topology and visible state at the selected point.

### Artifact panel

Selecting an artifact shows:

- content preview appropriate to media type;
- schema and version;
- digest and size;
- creator and producing execution;
- causing event;
- parent and derived artifacts;
- downstream consumers;
- policy decisions;
- sensitivity and retention state;
- validation and trust indicators.

## 6. Human intervention

The console surfaces intervention points, not raw event volume:

- approval required;
- clarification requested;
- work blocked;
- repeated failure;
- conflicting results;
- low confidence;
- budget nearly exhausted;
- irreversible action ready;
- dead-lettered work.

An approval decision must show the proposed action, requested capability, relevant artifacts, predicted effect, policy reason, and available alternatives.

## 7. Information hierarchy

The console supports three zoom levels:

```text
Installation
  → stable regions and system health
Region
  → local topology, work, constraints, and outputs
Execution or artifact
  → causation, attempts, content, policy, and provenance
```

Users should not need to read JSON for normal operation, though raw JSON remains accessible.

## 8. Product language

Prefer approachable labels in the UI:

- Factory Floor
- Stable Regions
- Work Cells
- Machines
- Lines
- Blueprints
- Inputs
- Outputs
- Bottlenecks

Use precise runtime terms in inspectors, APIs, logs, and documentation:

- Region
- Component Instance
- Connection
- Template
- Event
- Delivery
- Execution
- Attempt
- Artifact
- Capability
- Policy Decision

## 9. Initial routes

```text
/                          Factory Floor
/regions/:regionId         Work Cell
/executions/:executionId   Trace view
/artifacts/:artifactId     Artifact inspector
/approvals                 Approval queue
/alerts                    Alert list
```

## 10. Accessibility and performance

- All status distinctions must include icon or text, not color alone.
- Keyboard navigation is required for lists, inspectors, playback, and approvals.
- Respect reduced-motion preferences; replace moving pulses with static direction markers.
- Render sampled flow at high volume.
- The UI must remain responsive with 500 visible components and 5,000 timeline events through virtualization and aggregation.

## 11. Explicitly deferred

- free-form drag-and-drop graph editing;
- multiplayer presence;
- blueprint marketplace;
- automatic visual layout persistence as runtime topology;
- 3D rendering;
- game mechanics unrelated to operational meaning;
- personality avatars for components.

## 12. Console acceptance scenario

The investigation demo is visible on the Factory Floor. The operator opens its dynamic work cell, watches three retrieval machines fan out, sees verification fail, observes a replacement attempt, opens the preserved failure artifact, inspects the final result lineage, and confirms that cost, policy decisions, attempts, and completion reason agree with the API trace.
