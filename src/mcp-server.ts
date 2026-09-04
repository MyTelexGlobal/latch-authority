import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AuthorityLedger, type ChangeOperation } from "./authority.js";
import { GuardedWriter } from "./guarded-writer.js";
import { JsonAuthorityStateStore } from "./state-store.js";

const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CREATE"), path: z.string().min(1), nextContentHash: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("UPDATE"),
      path: z.string().min(1),
      expectedHash: z.string().min(1),
      nextContentHash: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("DELETE"), path: z.string().min(1), expectedHash: z.string().min(1) }).strict(),
]);

const contentSchema = z.object({ path: z.string().min(1), content: z.string() }).strict();

function result(payload: unknown) {
  return {
    structuredContent: payload as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected authority error.";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function workspaceFromArguments(args: string[]): string {
  const index = args.indexOf("--workspace");
  const workspace = index >= 0 ? args[index + 1] : undefined;
  if (!workspace || workspace.startsWith("-")) {
    throw new Error("Usage: npm run mcp -- --workspace /absolute/or/relative/project/path");
  }
  return workspace;
}

export function createAuthorityServer(
  ledger: AuthorityLedger,
  writer: GuardedWriter,
  persist: () => Promise<void>,
): McpServer {
  const server = new McpServer(
    { name: "latch-authority", version: "0.3.0" },
    {
      instructions:
        "Read authority state before proposing writes. HELD scopes are never reopened implicitly. An APPROVED proposal is a one-shot exception for its exact fingerprint.",
    },
  );

  const mutate = async <T>(operation: () => T): Promise<T> => {
    const value = operation();
    await persist();
    return value;
  };

  server.registerTool(
    "get_authority_state",
    {
      title: "Get authority state",
      description: "Read scopes, proposals, and the local audit sequence before proposing or applying changes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => result(ledger.snapshot()),
  );

  server.registerTool(
    "declare_scope",
    {
      title: "Declare authority scope",
      description: "Create a repository-relative OPEN or HELD scope. Use only for an explicit developer authority boundary.",
      inputSchema: {
        scope_id: z.string().min(1),
        path: z.string().min(1),
        status: z.enum(["OPEN", "HELD"]),
        reason: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ scope_id, path, status, reason }) => {
      try {
        return result(await mutate(() => ledger.declareScope({ id: scope_id, path, status, reason }, "HUMAN")));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "hold_scope",
    {
      title: "Hold scope",
      description: "Hold one declared scope after an explicit developer instruction. It blocks guarded writes only in that scope.",
      inputSchema: { scope_id: z.string().min(1), reason: z.string().min(1).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ scope_id, reason }) => {
      try {
        return result(await mutate(() => ledger.holdScope(scope_id, reason, "HUMAN")));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "release_scope",
    {
      title: "Release scope",
      description: "Release one HELD scope only after an explicit developer instruction naming that scope.",
      inputSchema: { scope_id: z.string().min(1), reason: z.string().min(1).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ scope_id, reason }) => {
      try {
        return result(await mutate(() => ledger.releaseScope(scope_id, reason, "HUMAN")));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_proposal",
    {
      title: "Create change proposal",
      description: "Create one exact, atomic change set. Include SHA-256 hashes for current and replacement file content.",
      inputSchema: { proposal_id: z.string().min(1), summary: z.string().min(1).optional(), operations: z.array(operationSchema).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ proposal_id, summary, operations }) => {
      try {
        return result(await mutate(() => ledger.createProposal(proposal_id, operations as ChangeOperation[], summary, "AGENT")));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "submit_proposal",
    {
      title: "Submit change proposal",
      description: "Move a prepared proposal to PENDING so its full change set can be evaluated against current held scopes.",
      inputSchema: { proposal_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ proposal_id }) => {
      try {
        const proposal = await mutate(() => ledger.submitProposal(proposal_id, "AGENT"));
        return result({ proposal, decision: ledger.evaluateProposal(proposal_id) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "object_proposal",
    {
      title: "Object to proposal",
      description: "Record a developer objection to one proposal without holding unrelated future work on the same path.",
      inputSchema: { proposal_id: z.string().min(1), reason: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ proposal_id, reason }) => {
      try {
        return result(await mutate(() => ledger.objectProposal(proposal_id, reason, "HUMAN")));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "approve_proposal",
    {
      title: "Approve exact proposal",
      description: "Record an explicit developer approval for one currently blocked proposal. It does not release the held scope.",
      inputSchema: { proposal_id: z.string().min(1), reason: z.string().min(1).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ proposal_id, reason }) => {
      try {
        return result(await mutate(() => ledger.approveProposal(proposal_id, reason, "HUMAN")));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "apply_proposal",
    {
      title: "Apply authorized proposal",
      description: "Write a complete proposal only after policy allows it. Replacement text must match the proposal's SHA-256 hashes exactly.",
      inputSchema: { proposal_id: z.string().min(1), contents: z.array(contentSchema) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ proposal_id, contents }) => {
      try {
        const applied = await writer.applyProposal(proposal_id, contents);
        await persist();
        return result(applied);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const workspace = workspaceFromArguments(process.argv.slice(2));
  if (!(await stat(workspace)).isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
  const stateStore = new JsonAuthorityStateStore(workspace);
  const ledger = await stateStore.load();
  const server = createAuthorityServer(ledger, new GuardedWriter(workspace, ledger), () => stateStore.save(ledger));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
