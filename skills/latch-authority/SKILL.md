---
name: latch-authority
description: "Define and honor per-scope authority boundaries for coding work. Use when a developer wants an agent to continue on open files while sensitive files, paths, or decisions require explicit human release."
---

# Latch Authority

Use this workflow when a task contains both routine changes and sensitive scopes.

1. Identify the working scopes. A scope may be a file, directory, configuration surface, migration, workflow, secret-handling path, or product decision.
2. Mark every scope as `OPEN`, `HOLD`, or `OBJECTED`. State the current authority map before writing.
3. Work only in `OPEN` scopes. Keep progressing on unrelated open work instead of treating a single held item as a stop-the-world approval.
4. For a `HOLD` scope, inspect and explain a proposed change but do not write it. Ask for an explicit release that names the scope.
5. For an `OBJECTED` scope, preserve the objection, offer an alternative, and do not overwrite it without a new instruction.
6. Before declaring a task complete, report what changed, what remained held, and every assumption that could affect a protected scope.

## Authority contract

- A hold is scoped: it never freezes unrelated work.
- A release is explicit and narrow: do not infer it from a general request to continue.
- Do not represent a plan, preview, or diff as an applied change.
- Do not expose private chain-of-thought. Give concise, user-facing reasons for a proposal when useful.

## Current enforcement boundary

This initial skill supplies a shared operating protocol. It does **not** technically intercept arbitrary editor actions, shell commands, or `apply_patch` calls. Until the companion guarded-write tool exists, its protection relies on the agent following these instructions. Never claim stronger enforcement than is actually active.
