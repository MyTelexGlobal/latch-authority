---
name: latch-authority
description: "Define and honor per-scope authority boundaries for coding work. Use when a developer wants an agent to continue on open files while sensitive files, paths, or decisions require explicit human release."
---

# Latch Authority

Use this workflow when a task contains both routine changes and sensitive scopes.

1. Identify the working scopes. A scope may be a file, directory, configuration surface, migration, workflow, secret-handling path, or product decision.
2. Mark every scope as `OPEN` or `HELD`. State the current authority map before writing.
3. Work only in `OPEN` scopes. Keep progressing on unrelated open work instead of treating one held item as a stop-the-world approval.
4. For a `HELD` scope, inspect and describe a proposed change but do not write it. Ask for an explicit release that names the scope, or request approval for that exact proposal.
5. Put disagreement on a proposal, not on a path: preserve the human's objection, offer an alternative proposal, and do not overwrite the object without a new instruction.
6. Before declaring a task complete, report what changed, what remained held, and every assumption that could affect a protected scope.

## Authority contract

- A hold is scoped: it never freezes unrelated work.
- A release is explicit and narrow: do not infer it from a general request to continue.
- A one-shot approval applies only the exact proposal it names; it does not reopen the scope.
- Do not represent a plan, preview, or diff as an applied change.
- Do not expose private chain-of-thought. Give concise, user-facing reasons for a proposal when useful.

## Current enforcement boundary

This initial skill supplies a shared operating protocol. It does **not** technically intercept arbitrary editor actions, shell commands, or `apply_patch` calls. Until the companion guarded-write tool exists, its protection relies on the agent following these instructions. Never claim stronger enforcement than is actually active.
