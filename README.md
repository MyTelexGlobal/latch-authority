# LATCH Authority

LATCH Authority is an experimental Codex plugin for **revocable, per-scope authority** in agent-assisted coding.

The developer can hold a sensitive scope—such as an authentication path, deployment workflow, migration, or architectural decision—while the agent continues working on every scope that remains open. It is an alternative to the usual binary choice: delegate everything or stop the whole task.

## Status

This release contains a Codex skill and a tested, in-memory proposal-based authority core:

- A scope is `OPEN` or `HELD`.
- A proposal is evaluated as one atomic change set.
- A human can approve one exact blocked proposal without broadly reopening a held scope.
- Proposal records, SHA-256 content fingerprints, and an append-only audit sequence can be serialized into a local snapshot.

The core is intentionally separate from filesystem I/O. A local guarded writer now applies only routed proposals whose full change sets pass policy and SHA-256 content checks.

The guarded writer is a technical barrier for writes deliberately routed through its MCP tool. It cannot intercept arbitrary terminal, editor, or patch operations.

## Why this exists

One blocked file should not turn a productive agent session into a stop-the-world confirmation loop. LATCH Authority keeps the disagreement visible and local: protect the contested object, let the agent continue on the rest, and make release an explicit human action.

The original WebMCP deal-board demonstration is available at [LATCH](https://latch.aa-c41.workers.dev/). This coding-agent plugin is a separate experiment that applies the same interaction pattern to software work.

## Development plan

1. **P0 — authority protocol:** complete.
2. **P1 — proposal-based authority core:** complete; the local MCP adapter persists metadata and audit snapshots.
3. **P2 — guarded writes:** complete for routed writes; the local MCP server rejects held, stale, incomplete, and hash-mismatched change sets before any write runs.
4. **P3 — visible control surface:** a lightweight human control surface for scope state, proposals, objections, approvals, and releases.
5. **P4 — validation:** local installation, demo project, automated tests, and clear limits.

## Honest boundary

Only tools that deliberately route writes through the authority layer can be technically guarded. For a multi-file proposal, the writer verifies every expected hash before writing; on an in-process failure it attempts rollback. This is not a crash-safe filesystem transaction and does not intercept direct writes made outside the server. A future version may integrate with host-level hooks where the client offers them; that is not implemented or promised here.

## Local development

Requires Node.js 20 or later.

```bash
npm install
npm run typecheck
npm test
```

To run the local stdio MCP server against one workspace, see [Local MCP](docs/local-mcp.md).

## Licensing

LATCH Authority is licensed under [AGPL-3.0-or-later](LICENSE). A separate commercial license is available for organizations that need rights outside AGPL terms; see [LICENSING.md](LICENSING.md).
