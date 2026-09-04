import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AuthorityLedger, type AuthoritySnapshot } from "./authority.js";
import { AUTHORITY_STATE_DIRECTORY } from "./guarded-writer.js";

const STATE_FILE = "state.json";
const LOCK_FILE = "state.lock";
const LOCK_WAIT_LIMIT_MS = 5_000;
const STALE_LOCK_LIMIT_MS = 30_000;

/** Persists policy and audit metadata locally; proposal source text is never stored here. */
export class JsonAuthorityStateStore {
  private readonly stateDirectory: string;
  private readonly stateFile: string;
  private readonly lockFile: string;

  public constructor(workspaceRoot: string) {
    this.stateDirectory = resolve(workspaceRoot, AUTHORITY_STATE_DIRECTORY);
    this.stateFile = join(this.stateDirectory, STATE_FILE);
    this.lockFile = join(this.stateDirectory, LOCK_FILE);
  }

  public async load(): Promise<AuthorityLedger> {
    try {
      const raw = await readFile(this.stateFile, "utf8");
      const snapshot = JSON.parse(raw) as AuthoritySnapshot;
      return new AuthorityLedger({ snapshot });
    } catch (error: unknown) {
      if (this.isMissing(error)) return new AuthorityLedger();
      if (error instanceof SyntaxError) throw new Error(`Authority state is not valid JSON: ${this.stateFile}`);
      throw error;
    }
  }

  public async save(ledger: AuthorityLedger): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    const temporary = join(this.stateDirectory, `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(ledger.snapshot(), null, 2)}\n`, { encoding: "utf8", flag: "w" });
    await rename(temporary, this.stateFile);
  }

  /**
   * Serializes mutations across independent stdio server processes. Each
   * transaction reloads durable state while holding the lock, preventing an
   * older server instance from overwriting a newer human decision.
   */
  public async transact<T>(operation: (ledger: AuthorityLedger) => T | Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      const ledger = await this.load();
      const value = await operation(ledger);
      await this.save(ledger);
      return value;
    } finally {
      await release();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(this.stateDirectory, { recursive: true });
    const startedAt = Date.now();

    while (true) {
      try {
        const handle = await open(this.lockFile, "wx");
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.close();
        return async () => {
          await rm(this.lockFile, { force: true });
        };
      } catch (error: unknown) {
        if (!this.isAlreadyExists(error)) throw error;
        await this.removeStaleLock();
        if (Date.now() - startedAt >= LOCK_WAIT_LIMIT_MS) {
          throw new Error(`Authority state is busy: ${this.stateFile}`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const metadata = await stat(this.lockFile);
      if (Date.now() - metadata.mtimeMs > STALE_LOCK_LIMIT_MS) {
        await rm(this.lockFile, { force: true });
      }
    } catch (error: unknown) {
      if (!this.isMissing(error)) throw error;
    }
  }

  private isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }

  private isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
  }
}
