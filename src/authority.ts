export type AuthorityStatus = "OPEN" | "HOLD" | "OBJECTED";

export interface AuthorityScope {
  id: string;
  path: string;
  status: AuthorityStatus;
  reason?: string;
}

export interface AuthorityEvent {
  scopeId: string;
  from: AuthorityStatus;
  to: AuthorityStatus;
  reason?: string;
}

export type WriteDecision =
  | { allowed: true }
  | {
      allowed: false;
      scope: AuthorityScope;
      message: string;
    };

function normalizeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");

  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Expected a repository-relative path, received: ${path}`);
  }

  return normalized;
}

function scopeContainsPath(scopePath: string, candidatePath: string): boolean {
  return candidatePath === scopePath || candidatePath.startsWith(`${scopePath}/`);
}

export class AuthorityLedger {
  private readonly scopes = new Map<string, AuthorityScope>();
  private readonly events: AuthorityEvent[] = [];

  public declareScope(scope: AuthorityScope): void {
    if (!scope.id.trim()) {
      throw new Error("A scope id is required.");
    }

    if (this.scopes.has(scope.id)) {
      throw new Error(`Scope already exists: ${scope.id}`);
    }

    this.scopes.set(scope.id, { ...scope, path: normalizeRelativePath(scope.path) });
  }

  public setStatus(scopeId: string, status: AuthorityStatus, reason?: string): AuthorityScope {
    const previous = this.scopes.get(scopeId);
    if (!previous) {
      throw new Error(`Unknown scope: ${scopeId}`);
    }

    const next = { ...previous, status, reason };
    this.scopes.set(scopeId, next);
    this.events.push({ scopeId, from: previous.status, to: status, reason });
    return { ...next };
  }

  public canWrite(path: string): WriteDecision {
    const target = normalizeRelativePath(path);
    const blockingScope = [...this.scopes.values()]
      .filter((scope) => scope.status !== "OPEN" && scopeContainsPath(scope.path, target))
      .sort((left, right) => right.path.length - left.path.length)[0];

    if (!blockingScope) {
      return { allowed: true };
    }

    return {
      allowed: false,
      scope: { ...blockingScope },
      message: `${blockingScope.status}: ${target} is inside ${blockingScope.path}.`,
    };
  }

  public listScopes(): AuthorityScope[] {
    return [...this.scopes.values()].map((scope) => ({ ...scope }));
  }

  public listEvents(): AuthorityEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}
