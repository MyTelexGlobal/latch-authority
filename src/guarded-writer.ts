import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ChangeOperation, Proposal } from "./authority.js";
import { AuthorityLedger } from "./authority.js";

export const AUTHORITY_STATE_DIRECTORY = ".latch-authority";

export interface ProposedFileContent {
  path: string;
  content: string;
}

export interface ApplyResult {
  proposal: Proposal;
  affectedPaths: string[];
}

interface FileSnapshot {
  target: string;
  existed: boolean;
  content?: string;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The enforcement boundary for writes deliberately routed through LATCH.
 * It does not and cannot intercept arbitrary editor, shell, or patch writes.
 */
export class GuardedWriter {
  private readonly root: string;
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(workspaceRoot: string, private readonly ledger: AuthorityLedger) {
    this.root = resolve(workspaceRoot);
  }

  public applyProposal(proposalId: string, contents: ProposedFileContent[]): Promise<ApplyResult> {
    return this.enqueue(() => this.applyExclusive(proposalId, contents));
  }

  private async applyExclusive(proposalId: string, contents: ProposedFileContent[]): Promise<ApplyResult> {
    const decision = this.ledger.evaluateProposal(proposalId);
    if (!decision.allowed) throw new Error(decision.message);

    const proposal = decision.proposal;
    const contentByPath = this.validateContents(proposal.operations, contents);
    const snapshots = await Promise.all(
      proposal.operations.map(async (operation) => this.preflight(operation, contentByPath.get(operation.path))),
    );
    const tempPaths: string[] = [];

    try {
      for (const operation of proposal.operations) {
        if (operation.kind === "DELETE") continue;
        const target = this.resolveTarget(operation.path);
        const content = contentByPath.get(operation.path);
        if (content === undefined) throw new Error(`Missing content for ${operation.path}.`);
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.latch-${randomUUID()}.tmp`;
        await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
        tempPaths.push(temporary);
      }

      for (const operation of proposal.operations) {
        const target = this.resolveTarget(operation.path);
        if (operation.kind === "DELETE") {
          await unlink(target);
        } else {
          const temporary = tempPaths.find((path) => path.startsWith(`${target}.latch-`));
          if (!temporary) throw new Error(`Staged content is missing for ${operation.path}.`);
          await rename(temporary, target);
        }
      }

      // Re-evaluate after I/O. A concurrent HOLD makes the proposal fail and
      // triggers rollback instead of leaving a write outside current policy.
      const applied = this.ledger.markApplied(proposalId, "SYSTEM");
      return { proposal: applied, affectedPaths: proposal.operations.map((operation) => operation.path) };
    } catch (error) {
      await this.rollback(snapshots);
      throw error;
    } finally {
      await Promise.all(tempPaths.map(async (path) => rm(path, { force: true })));
    }
  }

  private async preflight(operation: ChangeOperation, submittedContent: string | undefined): Promise<FileSnapshot> {
    const target = this.resolveTarget(operation.path);
    await this.assertNoSymlinkInPath(target);
    const existing = await this.readExisting(target);

    if (operation.kind === "CREATE") {
      if (existing.existed) throw new Error(`CREATE requires an absent path: ${operation.path}`);
      this.assertNextContent(operation, submittedContent);
      return existing;
    }

    if (!existing.existed) throw new Error(`${operation.kind} requires an existing path: ${operation.path}`);
    if (sha256(existing.content ?? "") !== operation.expectedHash) {
      throw new Error(`Workspace content no longer matches expectedHash: ${operation.path}`);
    }
    if (operation.kind === "UPDATE") this.assertNextContent(operation, submittedContent);
    if (operation.kind === "DELETE" && submittedContent !== undefined) {
      throw new Error(`DELETE must not include replacement content: ${operation.path}`);
    }
    return existing;
  }

  private assertNextContent(operation: ChangeOperation, content: string | undefined): void {
    if (content === undefined) throw new Error(`Missing replacement content for ${operation.path}.`);
    if (sha256(content) !== operation.nextContentHash) {
      throw new Error(`Replacement content does not match nextContentHash: ${operation.path}`);
    }
  }

  private validateContents(operations: ChangeOperation[], contents: ProposedFileContent[]): Map<string, string> {
    const allowed = new Set(operations.filter((operation) => operation.kind !== "DELETE").map((operation) => operation.path));
    const values = new Map<string, string>();
    for (const entry of contents) {
      if (values.has(entry.path)) throw new Error(`Replacement content is repeated: ${entry.path}`);
      if (!allowed.has(entry.path)) throw new Error(`Replacement content is not part of this proposal: ${entry.path}`);
      values.set(entry.path, entry.content);
    }
    if (values.size !== allowed.size) {
      throw new Error("Replacement content must be supplied for every CREATE or UPDATE operation.");
    }
    return values;
  }

  private resolveTarget(path: string): string {
    if (path === AUTHORITY_STATE_DIRECTORY || path.startsWith(`${AUTHORITY_STATE_DIRECTORY}/`)) {
      throw new Error(`Authority state is not a writable proposal target: ${path}`);
    }
    const target = resolve(this.root, path);
    const outside = relative(this.root, target);
    if (outside === "" || outside.startsWith("..") || isAbsolute(outside)) {
      throw new Error(`Path escapes the configured workspace: ${path}`);
    }
    return target;
  }

  private async readExisting(target: string): Promise<FileSnapshot> {
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Only regular files may be changed: ${target}`);
      }
      return { target, existed: true, content: await readFile(target, "utf8") };
    } catch (error: unknown) {
      if (this.isMissing(error)) return { target, existed: false };
      throw error;
    }
  }

  private async assertNoSymlinkInPath(target: string): Promise<void> {
    const steps = relative(this.root, target).split("/");
    let current = this.root;
    for (const step of steps) {
      current = resolve(current, step);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links are not writable: ${current}`);
      } catch (error: unknown) {
        if (this.isMissing(error)) return;
        throw error;
      }
    }
  }

  private async rollback(snapshots: FileSnapshot[]): Promise<void> {
    for (const snapshot of [...snapshots].reverse()) {
      if (snapshot.existed) {
        await mkdir(dirname(snapshot.target), { recursive: true });
        await writeFile(snapshot.target, snapshot.content ?? "", "utf8");
      } else {
        await rm(snapshot.target, { force: true });
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(operation, operation);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
