import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { AUTHORITY_PANEL_URI, authorityPanelHtml } from "./authority-panel.js";
import { GuardedWriter, sha256 } from "./guarded-writer.js";
import { createAuthorityServer } from "./mcp-server.js";
import { JsonAuthorityStateStore } from "./state-store.js";

const temporaryRoots: string[] = [];

async function connectedServer(root: string) {
  const store = new JsonAuthorityStateStore(root);
  const server = createAuthorityServer(root, store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "latch-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LATCH Authority MCP server", () => {
  it("ships a syntactically valid, portable MCP Apps panel without browser prompts", () => {
    const html = authorityPanelHtml();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(html).toContain('"ui/initialize"');
    expect(html).toContain('"ui/notifications/tool-result"');
    expect(html).toContain('"tools/call"');
    expect(html).toContain('"visibilitychange"');
    expect(html).not.toContain("window.prompt");
  });

  it("lists focused tools and applies an open proposal through the guarded writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "latch-mcp-"));
    temporaryRoots.push(root);
    const { client, server } = await connectedServer(root);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["get_authority_state", "render_authority_panel", "create_proposal", "apply_proposal"]),
    );
    const resource = await client.readResource({ uri: AUTHORITY_PANEL_URI });
    expect(resource.contents[0]).toMatchObject({ uri: AUTHORITY_PANEL_URI, mimeType: "text/html;profile=mcp-app" });
    const panel = await call(client, "render_authority_panel", {});
    expect(panel.structuredContent).toMatchObject({ decisions: [] });

    const next = "export const ready = true;\n";
    await call(client, "create_proposal", {
      proposal_id: "create-ready",
      operations: [{ kind: "CREATE", path: "src/ready.ts", nextContentHash: sha256(next) }],
    });
    await call(client, "submit_proposal", { proposal_id: "create-ready" });
    const applied = await call(client, "apply_proposal", {
      proposal_id: "create-ready",
      contents: [{ path: "src/ready.ts", content: next }],
    });

    expect(applied.isError).toBeUndefined();
    await expect(readFile(join(root, "src/ready.ts"), "utf8")).resolves.toBe(next);
    await client.close();
    await server.close();
  });

  it("persists authority state locally without persisting proposal source text", async () => {
    const root = await mkdtemp(join(tmpdir(), "latch-mcp-"));
    temporaryRoots.push(root);
    const { client, server } = await connectedServer(root);
    const next = "secret source stays outside authority state";

    await call(client, "create_proposal", {
      proposal_id: "private-source",
      operations: [{ kind: "CREATE", path: "src/new.ts", nextContentHash: sha256(next) }],
    });
    const saved = await readFile(join(root, ".latch-authority/state.json"), "utf8");

    expect(saved).toContain("private-source");
    expect(saved).not.toContain(next);
    await client.close();
    await server.close();
  });

  it("reloads and serializes authority state across independent stdio server instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "latch-mcp-"));
    temporaryRoots.push(root);
    const first = await connectedServer(root);
    const second = await connectedServer(root);

    await Promise.all([
      call(first.client, "declare_scope", { scope_id: "server", path: "src/server.ts", status: "HELD" }),
      call(second.client, "declare_scope", { scope_id: "config", path: "src/config.ts", status: "HELD" }),
    ]);

    const afterBothWrites = await call(second.client, "get_authority_state", {});
    const scopesAfterBothWrites = (afterBothWrites.structuredContent as { scopes: unknown[] }).scopes;
    expect(scopesAfterBothWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "server", status: "HELD", revision: 1 }),
        expect.objectContaining({ id: "config", status: "HELD", revision: 1 }),
      ]),
    );

    await call(first.client, "release_scope", { scope_id: "server" });
    const secondServerView = await call(second.client, "get_authority_state", {});
    const scopesAfterRelease = (secondServerView.structuredContent as { scopes: unknown[] }).scopes;
    expect(scopesAfterRelease).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "server", status: "OPEN", revision: 2 })]),
    );

    await first.client.close();
    await first.server.close();
    await second.client.close();
    await second.server.close();
  });
});
