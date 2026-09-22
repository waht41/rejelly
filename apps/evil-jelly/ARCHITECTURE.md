# Evil Jelly architecture direction

This document records the ownership boundaries that should guide incremental refactoring of
`apps/evil-jelly`. It describes a target direction, not a requirement to rewrite the current tree in
one pass.

Behavior, persisted data compatibility, and host safety boundaries take priority over structural
purity. Move code without changing behavior first; change protocols only in later, separately
reviewable steps.

## Current shape

The existing top-level areas remain useful:

- `domains/` owns durable or externally meaningful capabilities such as workspace access, sessions,
  MCP, Memory, Skills, and web access.
- `features/` owns product flows that compose capabilities, including unified coding, Audit,
  inspection, and replay.
- `cli/` owns process entry, terminal interaction, operator decisions, and presentation.
- `shared/` contains stable cross-owner contracts and low-level primitives. It is not the default
  destination for code that does not yet have an owner.

The main structural risk is no longer the top-level split. Interactive run and session lifecycle
now live under `cli/unified-conversation/`, while entry and presentation keep narrow integration
points. Semantic references are still implemented as parallel Skill, MCP, and Memory pipelines.
Unified conversation context policy lives with its owning feature under
`features/unified/context-management/`.

## Target owners

### Interactive conversation session

**User-visible behavior**

An interactive session accepts structured input, routes local commands, executes Agent turns,
persists recoverable state, reports progress, supports interruption, and can switch or resume a
session.

**Owns**

- the interactive run and segment lifecycle;
- local-command routing;
- one-turn execution and failure closure;
- conversation history, budget, context-anchor, and restored-session coordination;
- the boundary between a submitted prompt and durable session recording.

**Does not own**

- terminal rendering details;
- workspace, MCP, Memory, Skill, or session-storage rules;
- model construction and process-wide configuration;
- the internal behavior of local command capabilities.

**Composition root**

The CLI entry may create models, bindings, runtimes, and recorders and pass them to this owner. The
entry should select a run mode and assemble dependencies, not implement turn or resume rules.

**Forbidden knowledge**

Domains must not depend on this CLI owner. Presentation components must not mutate conversation or
session state except through its explicit input and action contracts.

### Semantic prompt references

**User-visible behavior**

The composer can insert and display typed `$...` references such as Skills, MCP servers, and Memory
entries. Submission freezes their selected identities so resume and replay do not reinterpret an old
input using unrelated live state.

**Owns**

- reference-token editing, selection, display naming, deduplication, and per-kind selection limits;
- conversion from an editable composer document to structured prompt input;
- delegation of live reference resolution to the capability that owns that reference kind.

**Does not own**

- Skill loading;
- MCP authorization or connection lifecycle;
- Memory persistence or mutation confirmation;
- durable session storage format beyond the stable frozen-input contract.

**Composition root**

The interactive CLI supplies bounded catalogs from the owning capabilities to the composer. Each
capability resolves and freezes its own reference semantics; the composer must not learn its runtime
or storage internals.

**Forbidden knowledge**

Reference editing must not import domain repositories or runtime managers. Session persistence must
not import composer state or terminal UI models.

### Durable session

**User-visible behavior**

A submitted conversation can be resumed with its active context, transcript, usage, references,
tool observations, and interruption state intact. Corrupt or incompatible state fails explicitly
rather than silently selecting another history.

**Owns**

- persisted event schemas and schema-version compatibility;
- append-only journal reading and writing;
- recovery and projection from events;
- migration from supported legacy formats;
- repository and recorder operations over the journal;
- blob identities and durable user-input materialization.

`model`, `journal`, `projection`, `repository`, and `recorder` are internal segments of one session
owner unless a future independent consumer or permission boundary proves otherwise.

**Does not own**

- CLI resume screens and pickers;
- conversation command routing;
- model prompting or compaction policy;
- MCP, Memory, or Skill live runtime state beyond persisted snapshots and stable event payloads.

**Composition root**

The CLI creates a repository/recorder and gives the interactive conversation owner narrow session
operations. UI code should not read journal files directly.

**Forbidden knowledge**

Session model and journal code must not depend on CLI, feature, Ink, React, or Zustand modules.
Projection must remain deterministic over persisted input and explicit materialization resources.

## Representative change scenarios

These scenarios are architecture smoke tests. A later refactor is useful only if it reduces their
unrelated change surface without weakening behavior or compatibility.

### Add a new semantic reference kind

Expected change surface:

1. define the capability-owned catalog identity and frozen representation;
2. register its composer editing/display behavior;
3. resolve it during submission;
4. add backward-compatible session schema support when persistence changes;
5. add owner-local behavior tests.

It should not require adding a parallel method to every host, decision-store, binding, run-loop, and
presentation interface. Shared UI arbitration may use a discriminated request/action protocol, while
the reference's domain semantics remain with its capability.

### Change the session schema

Expected change surface:

1. update the session model and compatibility parser;
2. update journal/projection/repository behavior that interprets the event;
3. update migration or recovery behavior when required;
4. update session-owner tests and the narrow conversation integration point.

Crossing internal session segments is acceptable because they share one durable lifecycle. Requiring
unrelated composer, manager, or terminal-renderer changes is a boundary warning.

### Change approval or confirmation policy

Expected change surface:

1. update the policy owner and its focused tests;
2. update the stable host confirmation contract only if the host must express a new decision;
3. update one composition binding per supported host mode.

Workspace write implementations, Memory mutation semantics, and MCP native calls may request
different confirmation payloads, but they must not import Ink stores or implement terminal decision
flow themselves.

## Rules for new and moved code

1. Name an entity, capability, or lifecycle owner before adding a top-level directory.
2. Do not add top-level `policy`, `service`, `runtime`, `store`, `types`, `lib`, or `utils` areas
   without an independently explainable owner and consumer boundary.
3. Keep single-consumer implementations with their owner. Do not move owner vocabulary into
   `shared/` merely to satisfy an import direction.
4. Treat internal directories as navigation segments by default. Add a Jelly lint node only when it
   protects a real forbidden dependency, permission boundary, or independently consumed contract.
5. Allow composition roots to have high fan-out, but keep rules and mutable capability state out of
   them.
6. Prefer direct imports from the owning module over broad barrels and compatibility re-exports.
7. Keep behavior tests next to the owner. Test-only fixtures belong under that owner's `__tests__`
   area.
8. Separate pure moves from behavior or protocol changes. Each migration batch must remain
   independently verifiable and reversible.
9. Do not split a cohesive state machine, schema, or parser solely because of line count. Split only
   when the extracted concept has a distinct change driver or test boundary.
10. Use lint to express prohibited knowledge, not to permanently encode every current directory and
    import edge.

## Planned migration order

1. **Completed:** move unified-conversation context and compaction policy to
   `features/unified/context-management/` without behavior changes.
2. **Completed:** gather the interactive run and session lifecycle under
   `cli/unified-conversation/interactive/` while keeping entry and presentation contracts stable.
3. Extract turn execution and session coordination from the current CLI orchestrator by lifecycle,
   not into generic helpers.
4. Consolidate repeated operator-manager arbitration only after the common request/action behavior
   is explicit.
5. Consolidate repeated composer reference mechanics while preserving capability-owned resolution.
6. Rework Jelly lint boundaries after the physical ownership has stabilized.

Every batch should pass `pnpm verify --filter @rejelly/evil-jelly`. Reduced file count or node count is
not itself success; representative changes should require fewer unrelated owners and less cross-tree
reasoning.
