import crypto from "node:crypto";
import { z } from "zod";
import {
  type MemoryAddInput,
  type MemoryDeleteInput,
  type MemoryListInput,
  type MemoryScope,
  type MemoryUpdateInput,
  memoryAddInputSchema,
  memoryConfirmationSchema,
  memoryDeleteInputSchema,
  memoryListInputSchema,
  memoryUpdateInputSchema,
  type PersistentMemoryEntryV1,
  type UserMemoryConfirmation,
} from "../model/memorySchema";
import {
  PersistentMemoryStore,
  PersistentMemoryStoreError,
} from "../repository/persistentMemoryStore";
import {
  MEMORY_ERROR_CODES,
  type MemoryMutationProposal,
  memoryMutationProposalSchema,
  PersistentMemoryError,
} from "./memoryMutationProposal";
import type {
  MemoryContextResult,
  MemoryListResult,
  MemoryMutationResult,
  MemorySourceContext,
  PersistentMemoryService,
} from "./persistentMemoryService";

function now(): string {
  return new Date().toISOString();
}

function generateMemoryId(): string {
  return `mem_${crypto.randomUUID()}`;
}

function canonicalMutationProjection(proposal: {
  readonly operation: string;
  readonly scope: string;
  readonly id: string;
  readonly expectedRevision: number;
  readonly before?: PersistentMemoryEntryV1;
  readonly after?: PersistentMemoryEntryV1;
}): string {
  const projectEntry = (entry: PersistentMemoryEntryV1 | undefined) =>
    entry
      ? {
          id: entry.id,
          scope: entry.scope,
          title: entry.title,
          summary: entry.summary,
          detail: entry.detail,
          revision: entry.revision,
        }
      : null;
  return JSON.stringify({
    operation: proposal.operation,
    scope: proposal.scope,
    id: proposal.id,
    expectedRevision: proposal.expectedRevision,
    before: projectEntry(proposal.before),
    after: projectEntry(proposal.after),
  });
}

function proposalHash(proposal: Parameters<typeof canonicalMutationProjection>[0]): string {
  return crypto.createHash("sha256").update(canonicalMutationProjection(proposal)).digest("hex");
}

function sourceForProvenance(source: MemorySourceContext) {
  return {
    source: source.source,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    ...(source.turnId ? { turnId: source.turnId } : {}),
  };
}

function createProvisionalEntry(
  input: MemoryAddInput,
  source: MemorySourceContext,
  id: string,
  proposedAt: string,
): PersistentMemoryEntryV1 {
  const sourceData = sourceForProvenance(source);
  const provisionalProvenance = {
    ...sourceData,
    proposedAt,
    confirmedAt: proposedAt,
    confirmedBy: "user" as const,
    confirmationSurface: "interactive_prompt" as const,
    proposalSha256: "0".repeat(64),
  };
  return {
    id,
    scope: input.scope ?? "project",
    title: input.title,
    summary: input.summary,
    detail: input.detail,
    revision: 1,
    createdAt: proposedAt,
    updatedAt: proposedAt,
    provenance: { created: provisionalProvenance, lastModified: provisionalProvenance },
  };
}

function withProposalHash(entry: PersistentMemoryEntryV1, hash: string): PersistentMemoryEntryV1 {
  return {
    ...entry,
    provenance: {
      created: { ...entry.provenance.created, proposalSha256: hash },
      lastModified: { ...entry.provenance.lastModified, proposalSha256: hash },
    },
  };
}

function sameContent(left: PersistentMemoryEntryV1, right: PersistentMemoryEntryV1): boolean {
  return (
    left.scope === right.scope &&
    left.title === right.title &&
    left.summary === right.summary &&
    left.detail === right.detail
  );
}

function sameEntry(left: PersistentMemoryEntryV1, right: PersistentMemoryEntryV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mutationError(error: unknown): PersistentMemoryError {
  if (error instanceof PersistentMemoryError) return error;
  if (error instanceof z.ZodError) {
    return new PersistentMemoryError("invalid_input", error.message, error);
  }
  if (error instanceof PersistentMemoryStoreError) {
    return new PersistentMemoryError(
      error.code === "lock_timeout" ? "conflict" : "store_unavailable",
      error.message,
      error,
    );
  }
  return new PersistentMemoryError(
    "store_unavailable",
    "Persistent memory operation failed",
    error,
  );
}

export interface PersistentMemoryServiceOptions {
  readonly workspaceRoot: string;
  readonly memoryRoot?: string;
  readonly store?: PersistentMemoryStore;
}

export class PersistentMemoryServiceImpl implements PersistentMemoryService {
  readonly store: PersistentMemoryStore;

  constructor(options: PersistentMemoryServiceOptions) {
    this.store =
      options.store ??
      new PersistentMemoryStore({
        workspaceRoot: options.workspaceRoot,
        memoryRoot: options.memoryRoot,
      });
  }

  async list(input?: MemoryListInput): Promise<MemoryListResult> {
    const parsed = memoryListInputSchema.parse(input ?? {});
    const scopes: MemoryScope[] = parsed.scope === "all" ? ["user", "project"] : [parsed.scope];
    const entries: PersistentMemoryEntryV1[] = [];
    const diagnostics: string[] = [];
    for (const scope of scopes) {
      try {
        const file = await this.store.read(scope);
        entries.push(
          ...file.entries.filter(
            (entry) => parsed.ids === undefined || parsed.ids.includes(entry.id),
          ),
        );
      } catch (error) {
        const diagnostic = mutationError(error);
        diagnostics.push(`${scope}: ${diagnostic.message}`);
      }
    }
    entries.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
    return {
      status: diagnostics.length === scopes.length ? "unavailable" : "ok",
      scope: parsed.scope,
      entries,
      ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join("\n") } : {}),
    };
  }

  async proposeAdd(
    input: MemoryAddInput,
    source: MemorySourceContext,
  ): Promise<MemoryMutationProposal> {
    const parsed = memoryAddInputSchema.parse(input);
    const scope = parsed.scope;
    const proposedAt = now();
    try {
      return await this.store.withLock(scope, ({ current }) => {
        const duplicate = current.entries.find(
          (entry) => entry.detail.trim() === parsed.detail.trim(),
        );
        if (duplicate) {
          throw new PersistentMemoryError(
            "unchanged",
            `Memory detail already exists as ${duplicate.id}`,
          );
        }
        if (current.entries.length >= 100) {
          throw new PersistentMemoryError("capacity_exceeded", `Memory scope is full: ${scope}`);
        }
        const id = generateMemoryId();
        const after = createProvisionalEntry(parsed, source, id, proposedAt);
        const hash = proposalHash({
          operation: "add",
          scope,
          id,
          expectedRevision: 0,
          after,
        });
        const proposal = memoryMutationProposalSchema.parse({
          version: 1,
          operation: "add",
          scope,
          id,
          expectedRevision: 0,
          after: withProposalHash(after, hash),
          source: sourceForProvenance(source),
          proposedAt,
          proposalSha256: hash,
        });
        return proposal;
      });
    } catch (error) {
      throw mutationError(error);
    }
  }

  async proposeUpdate(
    input: MemoryUpdateInput,
    source: MemorySourceContext,
  ): Promise<MemoryMutationProposal> {
    const parsed = memoryUpdateInputSchema.parse(input);
    const proposedAt = now();
    try {
      const userEntry = await this.findEntry("user", parsed.id);
      if (userEntry) return this.proposeUpdateInScope(parsed, source, "user", proposedAt);
      const projectEntry = await this.findEntry("project", parsed.id);
      if (projectEntry) return this.proposeUpdateInScope(parsed, source, "project", proposedAt);
      throw new PersistentMemoryError("not_found", `Memory not found: ${parsed.id}`);
    } catch (error) {
      throw mutationError(error);
    }
  }

  private async proposeUpdateInScope(
    input: MemoryUpdateInput,
    source: MemorySourceContext,
    scope: MemoryScope,
    proposedAt: string,
  ): Promise<MemoryMutationProposal> {
    return this.store.withLock(scope, ({ current }) => {
      const before = current.entries.find((entry) => entry.id === input.id);
      if (!before) throw new PersistentMemoryError("not_found", `Memory not found: ${input.id}`);
      const after: PersistentMemoryEntryV1 = {
        ...before,
        title: input.title ?? before.title,
        summary: input.summary ?? before.summary,
        detail: input.detail ?? before.detail,
      };
      if (sameContent(before, after)) {
        throw new PersistentMemoryError("unchanged", `Memory is unchanged: ${input.id}`);
      }
      const duplicate = current.entries.find(
        (entry) => entry.id !== before.id && entry.detail.trim() === after.detail.trim(),
      );
      if (duplicate)
        throw new PersistentMemoryError(
          "duplicate",
          `Memory detail already exists as ${duplicate.id}`,
        );
      const hash = proposalHash({
        operation: "update",
        scope,
        id: input.id,
        expectedRevision: before.revision,
        before,
        after,
      });
      const proposal = memoryMutationProposalSchema.parse({
        version: 1,
        operation: "update",
        scope,
        id: input.id,
        expectedRevision: before.revision,
        before,
        after: withProposalHash(after, hash),
        source: sourceForProvenance(source),
        proposedAt,
        proposalSha256: hash,
      });
      return proposal;
    });
  }

  async proposeDelete(
    input: MemoryDeleteInput,
    source: MemorySourceContext,
  ): Promise<MemoryMutationProposal> {
    const parsed = memoryDeleteInputSchema.parse(input);
    const proposedAt = now();
    try {
      const user = await this.findEntry("user", parsed.id);
      if (user) return this.buildDeleteProposal(user, source, proposedAt);
      const project = await this.findEntry("project", parsed.id);
      if (project) return this.buildDeleteProposal(project, source, proposedAt);
      throw new PersistentMemoryError("not_found", `Memory not found: ${parsed.id}`);
    } catch (error) {
      throw mutationError(error);
    }
  }

  private async findEntry(
    scope: MemoryScope,
    id: string,
  ): Promise<PersistentMemoryEntryV1 | undefined> {
    const file = await this.store.read(scope);
    return file.entries.find((entry) => entry.id === id);
  }

  private buildDeleteProposal(
    before: PersistentMemoryEntryV1,
    source: MemorySourceContext,
    proposedAt: string,
  ): MemoryMutationProposal {
    const hash = proposalHash({
      operation: "delete",
      scope: before.scope,
      id: before.id,
      expectedRevision: before.revision,
      before,
    });
    return memoryMutationProposalSchema.parse({
      version: 1,
      operation: "delete",
      scope: before.scope,
      id: before.id,
      expectedRevision: before.revision,
      before,
      source: sourceForProvenance(source),
      proposedAt,
      proposalSha256: hash,
    });
  }

  async commitConfirmed(
    proposal: MemoryMutationProposal,
    confirmation: UserMemoryConfirmation,
  ): Promise<MemoryMutationResult> {
    try {
      const parsedProposal = memoryMutationProposalSchema.parse(proposal);
      const parsedConfirmation = memoryConfirmationSchema.parse(confirmation);
      if (parsedConfirmation.proposalSha256 !== parsedProposal.proposalSha256) {
        return { status: "not_confirmed", code: MEMORY_ERROR_CODES.notConfirmed };
      }
      const expectedHash = proposalHash(parsedProposal);
      if (expectedHash !== parsedProposal.proposalSha256) {
        return { status: "not_confirmed", code: MEMORY_ERROR_CODES.notConfirmed };
      }
      return await this.store.mutate<MemoryMutationResult>(parsedProposal.scope, ({ current }) => {
        const currentEntry = current.entries.find((entry) => entry.id === parsedProposal.id);
        if (parsedProposal.operation === "add") {
          if (currentEntry) {
            return {
              file: current,
              value: {
                status: "conflict",
                code: "conflict",
                id: parsedProposal.id,
                scope: parsedProposal.scope,
              },
            };
          }
          const after = parsedProposal.after!;
          const duplicate = current.entries.find(
            (entry) => entry.detail.trim() === after.detail.trim(),
          );
          if (duplicate) {
            return {
              file: current,
              value: {
                status: "conflict",
                code: "conflict",
                id: duplicate.id,
                scope: parsedProposal.scope,
              },
            };
          }
          const confirmed = this.confirmEntry(after, parsedProposal, parsedConfirmation, true);
          return {
            file: { version: 1, entries: [...current.entries, confirmed] },
            value: {
              status: "committed",
              entry: confirmed,
              id: confirmed.id,
              scope: confirmed.scope,
              revision: confirmed.revision,
            },
          };
        }

        if (!currentEntry || currentEntry.revision !== parsedProposal.expectedRevision) {
          return {
            file: current,
            value: {
              status: "conflict",
              code: "conflict",
              id: parsedProposal.id,
              scope: parsedProposal.scope,
            },
          };
        }
        if (!parsedProposal.before || !sameEntry(currentEntry, parsedProposal.before)) {
          return {
            file: current,
            value: {
              status: "conflict",
              code: "conflict",
              id: parsedProposal.id,
              scope: parsedProposal.scope,
            },
          };
        }
        if (parsedProposal.operation === "delete") {
          return {
            file: {
              version: 1,
              entries: current.entries.filter((entry) => entry.id !== parsedProposal.id),
            },
            value: { status: "committed", id: parsedProposal.id, scope: parsedProposal.scope },
          };
        }
        const after = parsedProposal.after!;
        const duplicate = current.entries.find(
          (entry) => entry.id !== after.id && entry.detail.trim() === after.detail.trim(),
        );
        if (duplicate) {
          return {
            file: current,
            value: {
              status: "conflict",
              code: "conflict",
              id: duplicate.id,
              scope: parsedProposal.scope,
            },
          };
        }
        const updated = this.confirmEntry(after, parsedProposal, parsedConfirmation, false);
        return {
          file: {
            version: 1,
            entries: current.entries.map((entry) =>
              entry.id === parsedProposal.id ? updated : entry,
            ),
          },
          value: {
            status: "committed",
            entry: updated,
            id: updated.id,
            scope: updated.scope,
            revision: updated.revision,
          },
        };
      });
    } catch (error) {
      if (error instanceof PersistentMemoryError && error.code === "not_confirmed") {
        return { status: "not_confirmed", code: "not_confirmed" };
      }
      throw mutationError(error);
    }
  }

  private confirmEntry(
    entry: PersistentMemoryEntryV1,
    proposal: MemoryMutationProposal,
    confirmation: UserMemoryConfirmation,
    isAdd: boolean,
  ): PersistentMemoryEntryV1 {
    const source = {
      ...proposal.source,
      proposedAt: proposal.proposedAt,
      confirmedAt: confirmation.confirmedAt,
      confirmedBy: confirmation.confirmedBy,
      confirmationSurface: confirmation.confirmationSurface,
      proposalSha256: proposal.proposalSha256,
    };
    return {
      ...entry,
      revision: isAdd ? 1 : entry.revision + 1,
      createdAt: isAdd ? proposal.proposedAt : entry.createdAt,
      updatedAt: confirmation.confirmedAt,
      provenance: {
        created: isAdd ? source : proposal.before!.provenance.created,
        lastModified: source,
      },
    };
  }

  async loadContext(): Promise<MemoryContextResult> {
    const listed = await this.list({ scope: "all", view: "summary" });
    return {
      entries: listed.entries,
      diagnostics: listed.diagnostic ? listed.diagnostic.split("\n") : [],
    };
  }
}

export function createPersistentMemoryService(
  options: PersistentMemoryServiceOptions,
): PersistentMemoryServiceImpl {
  return new PersistentMemoryServiceImpl(options);
}
