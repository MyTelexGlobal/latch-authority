# Local MCP

The LATCH Authority server is a local stdio MCP server. It keeps its authority map and audit metadata in `.latch-authority/state.json` inside the workspace. That file contains paths, hashes, statuses, and audit data; it never contains the replacement source text sent to `apply_proposal`.

## Run locally

From a clone of this repository:

```bash
npm install
npm run mcp -- --workspace /absolute/path/to/your/project
```

The server uses stdin and stdout for MCP. Do not add log output to stdout.

## Example MCP configuration

Use absolute paths for both the plugin clone and the project you want to guard:

```json
{
  "mcpServers": {
    "latch-authority": {
      "command": "npm",
      "args": [
        "--prefix",
        "/absolute/path/to/latch-authority",
        "run",
        "mcp",
        "--",
        "--workspace",
        "/absolute/path/to/your/project"
      ]
    }
  }
}
```

The configuration is intentionally workspace-specific. A generic plugin manifest cannot safely guess which local repository a developer intends to guard.

## Tools

- `get_authority_state` reads scopes, proposals, and audit events.
- `declare_scope`, `hold_scope`, and `release_scope` manage per-path authority.
- `create_proposal` and `submit_proposal` create one atomic change set.
- `object_proposal` records feedback on a proposal without globally locking its path.
- `approve_proposal` creates a one-shot exception for a specific blocked proposal.
- `apply_proposal` writes only a policy-authorized proposal whose submitted file content matches its recorded SHA-256 hashes.
- `render_authority_panel` returns an MCP Apps component for inspecting scopes and making visible human decisions.

In an MCP Apps-compatible host, call `render_authority_panel` after reading state to display the panel. The component is optional: all tools work without it.

## Boundary

The server protects only writes sent to `apply_proposal`. It cannot block direct shell commands, editor writes, or other agent tools. The panel makes human approval and release interactions independently visible, but server-side caller identity is not established by the panel itself; callers must use approval and release tools only for explicit developer instructions.
