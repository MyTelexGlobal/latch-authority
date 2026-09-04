import { describe, expect, it } from "vitest";
import { AuthorityLedger } from "./authority.js";

const updateAuth = {
  kind: "UPDATE" as const,
  path: "src/auth/session.ts",
  expectedHash: "before-session",
  nextContentHash: "after-session",
};

describe("AuthorityLedger", () => {
  it("holds one scope while an unrelated pending proposal remains immediately writable", () => {
    const ledger = new AuthorityLedger({ now: () => "2026-09-04T00:00:00.000Z" });
    ledger.declareScope({ id: "auth", path: "src/auth", status: "HELD" });
    ledger.createProposal("profile-ui", [
      { kind: "UPDATE", path: "src/ui/profile.tsx", expectedHash: "before-ui", nextContentHash: "after-ui" },
    ]);
    ledger.submitProposal("profile-ui");

    expect(ledger.evaluateProposal("profile-ui")).toMatchObject({ allowed: true, requiresApproval: false });
    expect(ledger.markApplied("profile-ui")).toMatchObject({ status: "APPLIED" });
    expect(ledger.listScopes()).toEqual([{ id: "auth", path: "src/auth", status: "HELD", revision: 1 }]);
  });

  it("blocks an atomic change set before any of its operations can be applied", () => {
    const ledger = new AuthorityLedger();
    ledger.declareScope({ id: "auth", path: "src/auth", status: "HELD" });
    ledger.createProposal("mixed-change", [
      updateAuth,
      { kind: "UPDATE", path: "src/ui/profile.tsx", expectedHash: "before-ui", nextContentHash: "after-ui" },
    ]);
    ledger.submitProposal("mixed-change");

    expect(ledger.evaluateProposal("mixed-change")).toMatchObject({
      allowed: false,
      blockingScopes: [{ id: "auth", status: "HELD" }],
    });
    expect(() => ledger.markApplied("mixed-change")).toThrow("PENDING: mixed-change touches held scope(s): auth.");
    expect(ledger.listProposals()).toMatchObject([{ id: "mixed-change", status: "PENDING" }]);
  });

  it("approves one exact held-scope proposal without reopening that scope", () => {
    const ledger = new AuthorityLedger();
    ledger.declareScope({ id: "migration", path: "db/migrations", status: "HELD" });
    ledger.createProposal("add-index", [
      { kind: "CREATE", path: "db/migrations/002-add-index.sql", nextContentHash: "new-index-content" },
    ]);
    ledger.submitProposal("add-index");
    const approved = ledger.approveProposal("add-index", "This exact migration is safe.");

    expect(approved).toMatchObject({
      status: "APPROVED",
      approval: { heldScopes: [{ id: "migration", revision: 1 }] },
    });
    expect(ledger.evaluateProposal("add-index")).toMatchObject({ allowed: true, requiresApproval: true });
    ledger.markApplied("add-index");
    expect(ledger.listScopes()).toEqual([{ id: "migration", path: "db/migrations", status: "HELD", revision: 1 }]);
  });

  it("does not let a one-shot approval bypass a later hold, even for the same path", () => {
    const ledger = new AuthorityLedger();
    ledger.declareScope({ id: "auth", path: "src/auth", status: "HELD" });
    ledger.createProposal("session", [updateAuth]);
    ledger.submitProposal("session");
    ledger.approveProposal("session");
    ledger.releaseScope("auth", "Review finished.");
    ledger.holdScope("auth", "A new review began.");

    const decision = ledger.evaluateProposal("session");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.blockingScopes.map((scope) => scope.id)).toContain("auth");
    }
  });

  it("keeps objections on a proposal rather than converting them into a global path lock", () => {
    const ledger = new AuthorityLedger();
    ledger.createProposal("old-approach", [updateAuth]);
    ledger.objectProposal("old-approach", "Keep the existing session rotation design.");
    ledger.createProposal("new-approach", [
      { kind: "UPDATE", path: "src/auth/session.ts", expectedHash: "before-session", nextContentHash: "alternative" },
    ]);
    ledger.submitProposal("new-approach");

    expect(ledger.listProposals()).toMatchObject([
      { id: "old-approach", status: "OBJECTED", objection: "Keep the existing session rotation design." },
      { id: "new-approach", status: "PENDING" },
    ]);
    expect(ledger.evaluateProposal("new-approach")).toMatchObject({ allowed: true });
  });

  it("binds a proposal's SHA-256 hash to its canonical operation set and restores audited state", () => {
    const ledger = new AuthorityLedger({ now: () => "2026-09-04T00:00:00.000Z" });
    ledger.createProposal("two-files", [
      { kind: "CREATE", path: "src/b.ts", nextContentHash: "b" },
      { kind: "CREATE", path: "src/a.ts", nextContentHash: "a" },
    ]);
    ledger.submitProposal("two-files");
    const snapshot = ledger.snapshot();
    const restored = new AuthorityLedger({ snapshot });

    expect(snapshot.proposals[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(snapshot.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("rejects paths outside the repository boundary and ambiguous operations", () => {
    const ledger = new AuthorityLedger();

    expect(() => ledger.declareScope({ id: "bad", path: "../outside", status: "HELD" })).toThrow(
      "repository-relative path",
    );
    expect(() =>
      ledger.createProposal("ambiguous", [
        { kind: "CREATE", path: "src/a.ts", nextContentHash: "one" },
        { kind: "UPDATE", path: "src/a.ts", expectedHash: "one", nextContentHash: "two" },
      ]),
    ).toThrow("cannot contain multiple operations");
  });
});
