# LATCH Authority

LATCH Authority is an experimental Codex plugin for **revocable, per-scope authority** in agent-assisted coding.

The developer can hold a sensitive scope—such as an authentication path, deployment workflow, migration, or architectural decision—while the agent continues working on every scope that remains open. It is an alternative to the usual binary choice: delegate everything or stop the whole task.

## Status

The initial release contains a Codex skill and a small, tested in-memory path-policy foundation. The next core milestone implements the proposal-based model described in the [authority model](docs/architecture/authority-model.md):

- A scope is `OPEN` or `HELD`.
- A proposal is evaluated as a complete change set.
- A human can approve one exact proposal without broadly reopening a held scope.

The existing foundation resolves repository-relative paths and is covered by automated tests. It is not yet the guarded writer.

The plugin is **not yet a technical write barrier**. It cannot intercept arbitrary terminal, editor, or patch operations. The next milestone is a local guarded-write MCP tool that reads the authority map and rejects writes to held scopes.

## Why this exists

One blocked file should not turn a productive agent session into a stop-the-world confirmation loop. LATCH Authority keeps the disagreement visible and local: protect the contested object, let the agent continue on the rest, and make release an explicit human action.

The original WebMCP deal-board demonstration is available at [LATCH](https://latch.aa-c41.workers.dev/). This coding-agent plugin is a separate experiment that applies the same interaction pattern to software work.

## Development plan

1. **P0 — authority protocol:** complete.
2. **P1 — proposal-based authority core:** scopes, proposals, one-shot approvals, persistence, and audit.
3. **P2 — guarded writes:** a local MCP tool that rejects change sets targeting held scopes.
4. **P3 — visible control surface:** a lightweight panel that shows scope state, proposals, and releases.
5. **P4 — validation:** local installation, demo project, automated tests, and clear limits.

## Honest boundary

Only tools that deliberately route writes through the authority layer can be technically guarded. A future version may integrate with host-level hooks where the client offers them; that is not implemented or promised here.

## Local development

Requires Node.js 20 or later.

```bash
npm install
npm run typecheck
npm test
```

The repository is an early, standalone plugin project. Packaging it into a local Codex marketplace comes after the guarded-write MCP server is implemented and tested.

## Licensing

LATCH Authority is licensed under [AGPL-3.0-or-later](LICENSE). A separate commercial license is available for organizations that need rights outside AGPL terms; see [LICENSING.md](LICENSING.md).
