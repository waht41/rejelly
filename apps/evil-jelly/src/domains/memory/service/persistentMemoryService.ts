import type {
  MemoryAddInput,
  MemoryDeleteInput,
  MemoryListInput,
  MemoryScope,
  MemoryUpdateInput,
  PersistentMemoryEntryV1,
  UserMemoryConfirmation,
} from "../model/memorySchema";
import type {
  MemoryMutationPreview,
  MemoryMutationProposal,
  MemoryProposalValidationError,
} from "./memoryMutationProposal";

export interface MemorySourceContext {
  readonly source: "agent_tool" | "slash_command";
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface MemoryListResult {
  readonly status: "ok" | "unavailable";
  readonly scope: "all" | MemoryScope;
  readonly entries: readonly PersistentMemoryEntryV1[];
  readonly diagnostic?: string;
}

export interface MemoryContextResult {
  readonly entries: readonly PersistentMemoryEntryV1[];
  readonly diagnostics: readonly string[];
}

export interface MemoryMutationResult {
  readonly status: "committed" | "unchanged" | "not_confirmed" | "conflict" | "unavailable";
  readonly code?: MemoryProposalValidationError | "not_confirmed" | "conflict";
  readonly entry?: PersistentMemoryEntryV1;
  readonly id?: string;
  readonly scope?: MemoryScope;
  readonly revision?: number;
}

/** Phase 0 contract: implementations must propose first and commit only after confirmation. */
export interface PersistentMemoryService {
  list(input?: MemoryListInput): Promise<MemoryListResult>;
  proposeAdd(input: MemoryAddInput, source: MemorySourceContext): Promise<MemoryMutationProposal>;
  proposeUpdate(
    input: MemoryUpdateInput,
    source: MemorySourceContext,
  ): Promise<MemoryMutationProposal>;
  proposeDelete(
    input: MemoryDeleteInput,
    source: MemorySourceContext,
  ): Promise<MemoryMutationProposal>;
  commitConfirmed(
    proposal: MemoryMutationProposal,
    confirmation: UserMemoryConfirmation,
  ): Promise<MemoryMutationResult>;
  loadContext(): Promise<MemoryContextResult>;
}

export type MemoryProposalResult =
  | { readonly status: "proposal"; readonly preview: MemoryMutationPreview }
  | {
      readonly status: "unchanged" | "not_found" | "duplicate" | "capacity_exceeded";
      readonly id?: string;
      readonly scope?: MemoryScope;
    };
