import { describe, expect, it } from "vitest";
import { AuthorityLedger } from "./authority.js";

describe("AuthorityLedger", () => {
  it("blocks a held scope but keeps unrelated work open", () => {
    const ledger = new AuthorityLedger();
    ledger.declareScope({
      id: "auth",
      path: "src/auth",
      status: "HOLD",
      reason: "The developer is reviewing the security model.",
    });

    expect(ledger.canWrite("src/auth/session.ts")).toMatchObject({
      allowed: false,
      scope: { id: "auth", status: "HOLD" },
    });
    expect(ledger.canWrite("src/ui/profile.tsx")).toEqual({ allowed: true });
  });

  it("requires an explicit release before a held path becomes writable", () => {
    const ledger = new AuthorityLedger();
    ledger.declareScope({ id: "migration", path: "db/migrations", status: "HOLD" });

    ledger.setStatus("migration", "OPEN", "The developer released this scope.");

    expect(ledger.canWrite("db/migrations/002-add-index.sql")).toEqual({ allowed: true });
    expect(ledger.listEvents()).toEqual([
      {
        scopeId: "migration",
        from: "HOLD",
        to: "OPEN",
        reason: "The developer released this scope.",
      },
    ]);
  });

  it("treats an objection as a protected scope", () => {
    const ledger = new AuthorityLedger();
    ledger.declareScope({
      id: "deployment",
      path: ".github/workflows/deploy.yml",
      status: "OBJECTED",
      reason: "Keep the existing rollout strategy.",
    });

    expect(ledger.canWrite(".github/workflows/deploy.yml")).toMatchObject({
      allowed: false,
      scope: { id: "deployment", status: "OBJECTED" },
    });
  });

  it("rejects paths outside the repository boundary", () => {
    const ledger = new AuthorityLedger();

    expect(() => ledger.declareScope({ id: "bad", path: "../outside", status: "HOLD" })).toThrow(
      "repository-relative path",
    );
  });
});
