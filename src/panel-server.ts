import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authorityPanelHtml } from "./authority-panel.js";
import { createAuthorityServer } from "./mcp-server.js";
import { JsonAuthorityStateStore } from "./state-store.js";

const PANEL_TOOL_NAMES = new Set([
  "get_authority_state",
  "hold_scope",
  "release_scope",
  "object_proposal",
  "approve_proposal",
]);

type ToolCall = { method?: unknown; params?: { name?: unknown; arguments?: unknown } };

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 64 * 1024) throw new Error("Request body is too large.");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function asToolCall(value: unknown): ToolCall {
  if (!value || typeof value !== "object") throw new Error("Expected a JSON tool call.");
  return value as ToolCall;
}

export type AuthorityPanelServer = {
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
};

/**
 * A localhost-only companion for testing the same panel outside an MCP Apps host.
 * It is deliberately not a network service and exposes only actions represented in
 * the visual control surface.
 */
export async function createAuthorityPanelServer(workspaceRoot: string): Promise<AuthorityPanelServer> {
  const stateStore = new JsonAuthorityStateStore(workspaceRoot);
  const mcpServer = createAuthorityServer(workspaceRoot, stateStore);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "latch-authority-panel", version: "0.4.0" });
  await client.connect(clientTransport);

  const httpServer: Server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(authorityPanelHtml());
      return;
    }
    if (request.method !== "POST" || pathname !== "/api/tools/call") {
      send(response, 404, { error: "Not found." });
      return;
    }
    try {
      const call = asToolCall(await readJson(request));
      if (call.method !== "tools/call") throw new Error("Only tools/call is supported.");
      const name = call.params?.name;
      if (typeof name !== "string" || !PANEL_TOOL_NAMES.has(name)) throw new Error("That tool is not available from the local panel.");
      const args = call.params?.arguments;
      if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) {
        throw new Error("Tool arguments must be an object.");
      }
      send(response, 200, await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }));
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "Local panel request failed." });
    }
  });

  return {
    async listen(port = 4173): Promise<string> {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, "127.0.0.1", resolve);
      });
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Could not determine the local panel address.");
      return `http://127.0.0.1:${address.port}`;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      await client.close();
      await mcpServer.close();
    },
  };
}

function workspaceFromArguments(args: string[]): string {
  const index = args.indexOf("--workspace");
  const workspace = index >= 0 ? args[index + 1] : undefined;
  if (!workspace || workspace.startsWith("-")) throw new Error("Usage: npm run panel -- --workspace /absolute/project/path [--port 4173]");
  return workspace;
}

function portFromArguments(args: string[]): number {
  const index = args.indexOf("--port");
  if (index < 0) return 4173;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("--port must be an integer from 1 through 65535.");
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const workspace = workspaceFromArguments(args);
  if (!(await stat(workspace)).isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
  const panel = await createAuthorityPanelServer(workspace);
  const url = await panel.listen(portFromArguments(args));
  process.stdout.write(`LATCH Authority panel: ${url}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
