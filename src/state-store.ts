import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AuthorityLedger, type AuthoritySnapshot } from "./authority.js";
import { AUTHORITY_STATE_DIRECTORY } from "./guarded-writer.js";

const STATE_FILE = "state.json";

/** Persists policy and audit metadata locally; proposal source text is never stored here. */
export class JsonAuthorityStateStore {
  private readonly stateDirectory: string;
  private readonly stateFile: string;

  public constructor(workspaceRoot: string) {
    this.stateDirectory = resolve(workspaceRoot, AUTHORITY_STATE_DIRECTORY);
    this.stateFile = join(this.stateDirectory, STATE_FILE);
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
    const temporary = join(this.stateDirectory, `${STATE_FILE}.${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(ledger.snapshot(), null, 2)}\n`, { encoding: "utf8", flag: "w" });
    await rename(temporary, this.stateFile);
  }

  private isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
