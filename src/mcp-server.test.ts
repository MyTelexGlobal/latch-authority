import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityLedger } from "./authority.js";
import { GuardedWriter, sha256 } from "./guarded-writer.js";
import { createAuthorityServer } from "./mcp-server.js";
import { JsonAuthorityStateStore } from "./state-store.js";

const temporaryRoots: string[] = [];

async function connectedServer(root: string) {
  const store = new JsonAuthorityStateStore(root);
  const ledger = await store.load();
  const server = createAuthorityServer(ledger, new GuardedWriter(root, ledger), () => store.save(ledger));
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
  it("lists focused tools and applies an open proposal through the guarded writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "latch-mcp-"));
    temporaryRoots.push(root);
    const { client, server } = await connectedServer(root);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_authority_state", "create_proposal", "apply_proposal"]));

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
});
