# Authority Model

## Purpose

LATCH Authority lets a developer retain control over a sensitive coding scope while an agent continues working on unrelated open work.

The model is designed around a simple rule: a protected scope is not a reason to stop an entire task. It is a reason to turn a specific proposed change into an explicit human decision.

## Two separate state machines

Scope policy and change proposals are different things and are modeled separately.

### Scope policy

A scope identifies a repository-relative file or directory.

- `OPEN`: guarded changes may affect the scope.
- `HELD`: guarded changes may inspect or propose changes to the scope, but may not write it.

Releasing a scope is an event that changes `HELD` back to `OPEN`; it is not a persistent third state.

### Proposal lifecycle

A proposal describes one concrete change set.

- `DRAFT`: the agent is preparing the change set.
- `PENDING`: the change set is ready for policy evaluation or review.
- `OBJECTED`: the human rejected this proposal and supplied feedback.
- `APPROVED`: the human approved this exact change set.
- `APPLIED`: the guarded writer completed the change set.
- `EXPIRED`: the proposal no longer matches the workspace state or its approval has expired.

An objection belongs to a proposal, not to a scope. A developer can reject one migration or implementation approach while still allowing a better proposal to be considered.

## Change sets are atomic

A proposal contains explicit file operations, the repository-relative paths they affect, and an expected hash for every existing file it changes.

The policy engine evaluates the complete set before any operation runs.

- If every touched scope is `OPEN`, the guarded writer may apply the change set.
- If any operation touches a `HELD` scope, the change set is blocked before any write occurs.
- A human can approve an exact blocked proposal as a one-shot exception. The proposal's content hash is part of that approval.

One-shot approval applies only that known proposal. The scope remains `HELD` afterward. The approval also records the current revision of each held scope, so releasing and holding the same path again invalidates the prior exception. Broadly reopening a scope is a separate, explicit human action.

## Authority boundary

The policy engine is independent of the agent host. It decides whether a proposal is allowed; it does not perform I/O itself.

The first enforcement adapter is a guarded MCP writer. Before changing a file, it verifies that every operation in the proposal is current and that replacement bytes match the proposal's SHA-256 hash. It can guarantee policy enforcement only for write operations routed through that adapter. Raw shell commands, editor writes, and unrelated tools cannot be intercepted by this project unless a host offers a trusted native enforcement hook.

This boundary is deliberate: LATCH Authority reports its actual protection level rather than presenting a cooperative workflow as universal sandboxing.

## Human control surface

The MCP Apps panel is a view over the server-owned authority state, not a second source of truth. It reads a fresh snapshot and invokes the same server tools for HOLD, release, objection, and exact approval. A host that does not render the panel still has the complete tool workflow. The panel makes a human decision visible; it does not claim to prove the identity of a caller that invokes an MCP tool outside the panel.

## Local state and audit

The authority map, proposal records, approvals, and audit events belong to the local workspace, not to the source repository.

Audit events record the actor type, action, affected paths, proposal identifier, and content hash. They do not require private model reasoning or a copy of source code. The local adapter exports a JSON snapshot to `.latch-authority/state.json`; it stores no proposal source text, and the guarded writer excludes this internal directory from proposal targets. Each mutation takes a short-lived local lock, reloads the durable ledger, and atomically replaces the snapshot, so independent stdio server instances cannot overwrite each other's authority decisions. The current adapter still cannot provide crash-consistent atomicity across both metadata and multiple filesystem operations.

## Initial object model

The first release treats a file or directory path as an object. The policy API is intentionally separated from path matching so future adapters can resolve richer objects, such as a named configuration block or an owned code symbol, without changing proposal or approval semantics.

## Non-goals for the first release

- Global interception of all local filesystem writes.
- Automatic approval or release of held scopes.
- Recording private chain-of-thought.
- Inferring a developer's intent from a broad request to continue.
