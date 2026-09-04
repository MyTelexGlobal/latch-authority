import { createHash } from "node:crypto";

export type AuthorityStatus = "OPEN" | "HELD";

export interface AuthorityScopeInput {
  id: string;
  path: string;
  status: AuthorityStatus;
  reason?: string;
}

export interface AuthorityScope extends AuthorityScopeInput {
  /** Changes whenever the scope policy changes; approvals bind to this version. */
  revision: number;
}

export type ProposalStatus = "DRAFT" | "PENDING" | "OBJECTED" | "APPROVED" | "APPLIED" | "EXPIRED";
export type ChangeKind = "CREATE" | "UPDATE" | "DELETE";
export type AuthorityActor = "AGENT" | "HUMAN" | "SYSTEM";

/** Content hashes describe source without retaining source text in the authority store. */
export interface ChangeOperation {
  kind: ChangeKind;
  path: string;
  expectedHash?: string;
  nextContentHash?: string;
}

export interface ProposalApproval {
  contentHash: string;
  heldScopes: Array<{ id: string; revision: number }>;
  reason?: string;
}

export interface Proposal {
  id: string;
  status: ProposalStatus;
  operations: ChangeOperation[];
  contentHash: string;
  summary?: string;
  objection?: string;
  approval?: ProposalApproval;
}

export interface AuthorityEvent {
  sequence: number;
  action:
    | "SCOPE_DECLARED"
    | "SCOPE_HELD"
    | "SCOPE_RELEASED"
    | "PROPOSAL_CREATED"
    | "PROPOSAL_SUBMITTED"
    | "PROPOSAL_OBJECTED"
    | "PROPOSAL_APPROVED"
    | "PROPOSAL_APPLIED"
    | "PROPOSAL_EXPIRED";
  actor: AuthorityActor;
  scopeId?: string;
  proposalId?: string;
  paths: string[];
  contentHash?: string;
  reason?: string;
  at: string;
}

export interface AuthoritySnapshot {
  version: 1;
  scopes: AuthorityScope[];
  proposals: Proposal[];
  events: AuthorityEvent[];
}

export type ProposalDecision =
  | { allowed: true; requiresApproval: false; proposal: Proposal }
  | { allowed: true; requiresApproval: true; proposal: Proposal }
  | { allowed: false; proposal: Proposal; blockingScopes: AuthorityScope[]; message: string };

export interface AuthorityLedgerOptions {
  now?: () => string;
  snapshot?: AuthoritySnapshot;
}

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

function cloneScope(scope: AuthorityScope): AuthorityScope {
  return { ...scope };
}

function cloneOperation(operation: ChangeOperation): ChangeOperation {
  return { ...operation };
}

function cloneProposal(proposal: Proposal): Proposal {
  return {
    ...proposal,
    operations: proposal.operations.map(cloneOperation),
    approval: proposal.approval
      ? { ...proposal.approval, heldScopes: proposal.approval.heldScopes.map((scope) => ({ ...scope })) }
      : undefined,
  };
}

function cloneEvent(event: AuthorityEvent): AuthorityEvent {
  return { ...event, paths: [...event.paths] };
}

function requireOpaqueHash(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function normalizeOperation(operation: ChangeOperation): ChangeOperation {
  const path = normalizeRelativePath(operation.path);
  switch (operation.kind) {
    case "CREATE":
      if (operation.expectedHash !== undefined) throw new Error(`CREATE must not include expectedHash: ${path}`);
      return { kind: "CREATE", path, nextContentHash: requireOpaqueHash(operation.nextContentHash, "nextContentHash") };
    case "UPDATE":
      return {
        kind: "UPDATE",
        path,
        expectedHash: requireOpaqueHash(operation.expectedHash, "expectedHash"),
        nextContentHash: requireOpaqueHash(operation.nextContentHash, "nextContentHash"),
      };
    case "DELETE":
      if (operation.nextContentHash !== undefined) throw new Error(`DELETE must not include nextContentHash: ${path}`);
      return { kind: "DELETE", path, expectedHash: requireOpaqueHash(operation.expectedHash, "expectedHash") };
  }
}

function normalizedOperations(operations: ChangeOperation[]): ChangeOperation[] {
  if (operations.length === 0) throw new Error("A proposal must include at least one change operation.");
  const normalized = operations.map(normalizeOperation).sort((left, right) => left.path.localeCompare(right.path));
  const duplicate = normalized.find((operation, index) => operation.path === normalized[index - 1]?.path);
  if (duplicate) throw new Error(`A proposal cannot contain multiple operations for ${duplicate.path}.`);
  return normalized;
}

function contentHashFor(operations: ChangeOperation[]): string {
  return createHash("sha256").update(JSON.stringify(operations)).digest("hex");
}

function isFinal(status: ProposalStatus): boolean {
  return status === "APPLIED" || status === "EXPIRED";
}

export class AuthorityLedger {
  private readonly scopes = new Map<string, AuthorityScope>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly events: AuthorityEvent[] = [];
  private readonly now: () => string;

  public constructor(options: AuthorityLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.snapshot) this.restore(options.snapshot);
  }

  public declareScope(scope: AuthorityScopeInput, actor: AuthorityActor = "HUMAN"): AuthorityScope {
    if (!scope.id.trim()) throw new Error("A scope id is required.");
    if (this.scopes.has(scope.id)) throw new Error(`Scope already exists: ${scope.id}`);
    const next: AuthorityScope = { ...scope, path: normalizeRelativePath(scope.path), revision: 1 };
    this.scopes.set(next.id, next);
    this.record("SCOPE_DECLARED", actor, { scopeId: next.id, paths: [next.path], reason: next.reason });
    return cloneScope(next);
  }

  public holdScope(scopeId: string, reason?: string, actor: AuthorityActor = "HUMAN"): AuthorityScope {
    return this.setScopeStatus(scopeId, "HELD", reason, actor);
  }

  public releaseScope(scopeId: string, reason?: string, actor: AuthorityActor = "HUMAN"): AuthorityScope {
    return this.setScopeStatus(scopeId, "OPEN", reason, actor);
  }

  public createProposal(id: string, operations: ChangeOperation[], summary?: string, actor: AuthorityActor = "AGENT"): Proposal {
    if (!id.trim()) throw new Error("A proposal id is required.");
    if (this.proposals.has(id)) throw new Error(`Proposal already exists: ${id}`);
    const normalized = normalizedOperations(operations);
    const proposal: Proposal = { id, status: "DRAFT", operations: normalized, contentHash: contentHashFor(normalized), summary };
    this.proposals.set(id, proposal);
    this.record("PROPOSAL_CREATED", actor, {
      proposalId: id,
      paths: normalized.map((operation) => operation.path),
      contentHash: proposal.contentHash,
      reason: summary,
    });
    return cloneProposal(proposal);
  }

  public submitProposal(id: string, actor: AuthorityActor = "AGENT"): Proposal {
    const proposal = this.requireProposal(id);
    this.transitionProposal(proposal, "PENDING", ["DRAFT"], actor, "PROPOSAL_SUBMITTED");
    return cloneProposal(proposal);
  }

  public objectProposal(id: string, reason: string, actor: AuthorityActor = "HUMAN"): Proposal {
    if (!reason.trim()) throw new Error("An objection reason is required.");
    const proposal = this.requireProposal(id);
    proposal.objection = reason;
    this.transitionProposal(proposal, "OBJECTED", ["DRAFT", "PENDING"], actor, "PROPOSAL_OBJECTED", reason);
    return cloneProposal(proposal);
  }

  /** Approves only this exact blocked proposal. Held scopes remain held. */
  public approveProposal(id: string, reason?: string, actor: AuthorityActor = "HUMAN"): Proposal {
    const proposal = this.requireProposal(id);
    if (proposal.status !== "PENDING") throw new Error(`Only a pending proposal can be approved: ${id}`);
    const blockingScopes = this.blockingScopesFor(proposal);
    if (blockingScopes.length === 0) throw new Error(`Proposal does not require an exception: ${id}`);
    proposal.approval = {
      contentHash: proposal.contentHash,
      heldScopes: blockingScopes.map((scope) => ({ id: scope.id, revision: scope.revision })),
      reason,
    };
    this.transitionProposal(proposal, "APPROVED", ["PENDING"], actor, "PROPOSAL_APPROVED", reason);
    return cloneProposal(proposal);
  }

  public expireProposal(id: string, reason: string, actor: AuthorityActor = "SYSTEM"): Proposal {
    if (!reason.trim()) throw new Error("An expiry reason is required.");
    const proposal = this.requireProposal(id);
    if (isFinal(proposal.status)) throw new Error(`A final proposal cannot expire: ${id}`);
    this.transitionProposal(proposal, "EXPIRED", ["DRAFT", "PENDING", "OBJECTED", "APPROVED"], actor, "PROPOSAL_EXPIRED", reason);
    return cloneProposal(proposal);
  }

  public evaluateProposal(id: string): ProposalDecision {
    const proposal = this.requireProposal(id);
    if (proposal.status === "PENDING") {
      const blockingScopes = this.blockingScopesFor(proposal);
      if (blockingScopes.length === 0) return { allowed: true, requiresApproval: false, proposal: cloneProposal(proposal) };
      return {
        allowed: false,
        proposal: cloneProposal(proposal),
        blockingScopes: blockingScopes.map(cloneScope),
        message: `PENDING: ${id} touches held scope(s): ${blockingScopes.map((scope) => scope.id).join(", ")}.`,
      };
    }
    if (proposal.status === "APPROVED" && this.approvalStillCovers(proposal)) {
      return { allowed: true, requiresApproval: true, proposal: cloneProposal(proposal) };
    }
    return {
      allowed: false,
      proposal: cloneProposal(proposal),
      blockingScopes: this.blockingScopesFor(proposal).map(cloneScope),
      message: `${proposal.status}: ${id} is not authorized to apply.`,
    };
  }

  /** Call only after the guarded writer has atomically completed every operation. */
  public markApplied(id: string, actor: AuthorityActor = "SYSTEM"): Proposal {
    const proposal = this.requireProposal(id);
    const decision = this.evaluateProposal(id);
    if (!decision.allowed) throw new Error(decision.message);
    this.transitionProposal(proposal, "APPLIED", ["PENDING", "APPROVED"], actor, "PROPOSAL_APPLIED");
    return cloneProposal(proposal);
  }

  public listScopes(): AuthorityScope[] {
    return [...this.scopes.values()].map(cloneScope);
  }

  public listProposals(): Proposal[] {
    return [...this.proposals.values()].map(cloneProposal);
  }

  public listEvents(): AuthorityEvent[] {
    return this.events.map(cloneEvent);
  }

  public snapshot(): AuthoritySnapshot {
    return { version: 1, scopes: this.listScopes(), proposals: this.listProposals(), events: this.listEvents() };
  }

  private setScopeStatus(scopeId: string, status: AuthorityStatus, reason: string | undefined, actor: AuthorityActor): AuthorityScope {
    const previous = this.scopes.get(scopeId);
    if (!previous) throw new Error(`Unknown scope: ${scopeId}`);
    if (previous.status === status) throw new Error(`Scope is already ${status}: ${scopeId}`);
    const next = { ...previous, status, reason, revision: previous.revision + 1 };
    this.scopes.set(scopeId, next);
    this.record(status === "HELD" ? "SCOPE_HELD" : "SCOPE_RELEASED", actor, { scopeId, paths: [next.path], reason });
    return cloneScope(next);
  }

  private requireProposal(id: string): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Unknown proposal: ${id}`);
    return proposal;
  }

  private blockingScopesFor(proposal: Proposal): AuthorityScope[] {
    return [...this.scopes.values()]
      .filter((scope) => scope.status === "HELD")
      .filter((scope) => proposal.operations.some((operation) => scopeContainsPath(scope.path, operation.path)))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private approvalStillCovers(proposal: Proposal): boolean {
    if (!proposal.approval || proposal.approval.contentHash !== proposal.contentHash) return false;
    return this.blockingScopesFor(proposal).every((scope) =>
      proposal.approval?.heldScopes.some(
        (approvedScope) => approvedScope.id === scope.id && approvedScope.revision === scope.revision,
      ),
    );
  }

  private transitionProposal(
    proposal: Proposal,
    status: ProposalStatus,
    permittedFrom: ProposalStatus[],
    actor: AuthorityActor,
    action: AuthorityEvent["action"],
    reason?: string,
  ): void {
    if (!permittedFrom.includes(proposal.status)) {
      throw new Error(`Cannot transition proposal ${proposal.id} from ${proposal.status} to ${status}.`);
    }
    proposal.status = status;
    this.record(action, actor, {
      proposalId: proposal.id,
      paths: proposal.operations.map((operation) => operation.path),
      contentHash: proposal.contentHash,
      reason,
    });
  }

  private record(
    action: AuthorityEvent["action"],
    actor: AuthorityActor,
    event: Omit<AuthorityEvent, "sequence" | "action" | "actor" | "at">,
  ): void {
    this.events.push({ sequence: this.events.length + 1, action, actor, at: this.now(), ...event });
  }

  private restore(snapshot: AuthoritySnapshot): void {
    if (snapshot.version !== 1) throw new Error(`Unsupported authority snapshot version: ${snapshot.version}`);
    if (snapshot.events.some((event, index) => event.sequence !== index + 1)) {
      throw new Error("Authority events must have contiguous sequence numbers.");
    }
    for (const scope of snapshot.scopes) {
      if (this.scopes.has(scope.id)) throw new Error(`Duplicate scope in snapshot: ${scope.id}`);
      if (!Number.isInteger(scope.revision) || scope.revision < 1) {
        throw new Error(`Scope revision must be a positive integer: ${scope.id}`);
      }
      this.scopes.set(scope.id, { ...scope, path: normalizeRelativePath(scope.path) });
    }
    for (const proposal of snapshot.proposals) {
      if (this.proposals.has(proposal.id)) throw new Error(`Duplicate proposal in snapshot: ${proposal.id}`);
      const operations = normalizedOperations(proposal.operations);
      if (contentHashFor(operations) !== proposal.contentHash) {
        throw new Error(`Proposal content hash does not match operations: ${proposal.id}`);
      }
      this.proposals.set(proposal.id, { ...cloneProposal(proposal), operations });
    }
    this.events.push(...snapshot.events.map(cloneEvent));
  }
}
