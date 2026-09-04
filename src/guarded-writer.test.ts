import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityLedger } from "./authority.js";
import { GuardedWriter, sha256 } from "./guarded-writer.js";

const temporaryRoots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "latch-authority-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GuardedWriter", () => {
  it("does not write any part of a mixed proposal that touches a held scope", async () => {
    const root = await workspace();
    await writeFile(join(root, "auth.ts"), "old auth");
    await writeFile(join(root, "ui.ts"), "old ui");
    const ledger = new AuthorityLedger();
    ledger.declareScope({ id: "auth", path: "auth.ts", status: "HELD" });
    ledger.createProposal("mixed", [
      { kind: "UPDATE", path: "auth.ts", expectedHash: sha256("old auth"), nextContentHash: sha256("new auth") },
      { kind: "UPDATE", path: "ui.ts", expectedHash: sha256("old ui"), nextContentHash: sha256("new ui") },
    ]);
    ledger.submitProposal("mixed");

    await expect(new GuardedWriter(root, ledger).applyProposal("mixed", [
      { path: "auth.ts", content: "new auth" },
      { path: "ui.ts", content: "new ui" },
    ])).rejects.toThrow("touches held scope");
    await expect(readFile(join(root, "auth.ts"), "utf8")).resolves.toBe("old auth");
    await expect(readFile(join(root, "ui.ts"), "utf8")).resolves.toBe("old ui");
  });

  it("applies an approved exact proposal without reopening its held scope", async () => {
    const root = await workspace();
    await writeFile(join(root, "migration.sql"), "before");
    const ledger = new AuthorityLedger();
    ledger.declareScope({ id: "migration", path: "migration.sql", status: "HELD" });
    ledger.createProposal("migration-fix", [
      { kind: "UPDATE", path: "migration.sql", expectedHash: sha256("before"), nextContentHash: sha256("after") },
    ]);
    ledger.submitProposal("migration-fix");
    ledger.approveProposal("migration-fix", "Apply this migration only.");

    const result = await new GuardedWriter(root, ledger).applyProposal("migration-fix", [
      { path: "migration.sql", content: "after" },
    ]);
    expect(result.proposal.status).toBe("APPLIED");
    await expect(readFile(join(root, "migration.sql"), "utf8")).resolves.toBe("after");
    expect(ledger.listScopes()).toMatchObject([{ id: "migration", status: "HELD" }]);
  });

  it("preflights every expected hash before changing any open file", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.ts"), "one");
    await writeFile(join(root, "b.ts"), "two");
    const ledger = new AuthorityLedger();
    ledger.createProposal("stale", [
      { kind: "UPDATE", path: "a.ts", expectedHash: sha256("one"), nextContentHash: sha256("new one") },
      { kind: "UPDATE", path: "b.ts", expectedHash: sha256("not two"), nextContentHash: sha256("new two") },
    ]);
    ledger.submitProposal("stale");

    await expect(new GuardedWriter(root, ledger).applyProposal("stale", [
      { path: "a.ts", content: "new one" },
      { path: "b.ts", content: "new two" },
    ])).rejects.toThrow("no longer matches expectedHash");
    await expect(readFile(join(root, "a.ts"), "utf8")).resolves.toBe("one");
    await expect(readFile(join(root, "b.ts"), "utf8")).resolves.toBe("two");
  });

  it("refuses replacement bytes whose hash differs from the approved proposal", async () => {
    const root = await workspace();
    await writeFile(join(root, "safe.ts"), "before");
    const ledger = new AuthorityLedger();
    ledger.createProposal("safe-change", [
      { kind: "UPDATE", path: "safe.ts", expectedHash: sha256("before"), nextContentHash: sha256("approved after") },
    ]);
    ledger.submitProposal("safe-change");

    await expect(new GuardedWriter(root, ledger).applyProposal("safe-change", [
      { path: "safe.ts", content: "different after" },
    ])).rejects.toThrow("does not match nextContentHash");
    await expect(readFile(join(root, "safe.ts"), "utf8")).resolves.toBe("before");
  });

  it("keeps the local authority state outside every proposal's write surface", async () => {
    const root = await workspace();
    const ledger = new AuthorityLedger();
    ledger.createProposal("tamper-state", [
      { kind: "CREATE", path: ".latch-authority/state.json", nextContentHash: sha256("tamper") },
    ]);
    ledger.submitProposal("tamper-state");

    await expect(new GuardedWriter(root, ledger).applyProposal("tamper-state", [
      { path: ".latch-authority/state.json", content: "tamper" },
    ])).rejects.toThrow("Authority state is not a writable proposal target");
  });
});
