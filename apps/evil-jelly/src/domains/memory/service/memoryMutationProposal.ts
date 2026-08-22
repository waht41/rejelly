import { z } from "zod";
import {
  type MemoryScope,
  type MemorySource,
  memoryIdSchema,
  memoryScopeSchema,
  memorySourceSchema,
  type PersistentMemoryEntryV1,
  persistentMemoryEntryV1Schema,
} from "../model/memorySchema";

export const MEMORY_MUTATION_SCHEMA_VERSION = 1 as const;

export const memoryMutationOperationSchema = z.enum(["add", "update", "delete"]);
export type MemoryMutationOperation = z.infer<typeof memoryMutationOperationSchema>;

const mutationProposalShape = {
  version: z.literal(MEMORY_MUTATION_SCHEMA_VERSION),
  operation: memoryMutationOperationSchema,
  scope: memoryScopeSchema,
  id: memoryIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  before: persistentMemoryEntryV1Schema.optional(),
  after: persistentMemoryEntryV1Schema.optional(),
  source: memorySourceSchema,
  proposedAt: z.string().datetime({ offset: false }),
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/),
};

export const memoryMutationProposalSchema = z
  .object(mutationProposalShape)
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.before && proposal.before.scope !== proposal.scope) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["before", "scope"],
        message: "Proposal before scope must match proposal scope",
      });
    }
    if (proposal.after && proposal.after.scope !== proposal.scope) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["after", "scope"],
        message: "Proposal after scope must match proposal scope",
      });
    }
    if (proposal.after && proposal.after.id !== proposal.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["after", "id"],
        message: "Proposal after id must match proposal id",
      });
    }
    if (proposal.before && proposal.before.id !== proposal.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["before", "id"],
        message: "Proposal before id must match proposal id",
      });
    }

    if (
      proposal.operation === "add" &&
      (proposal.before !== undefined || proposal.after === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "An add proposal requires after and must not have before",
      });
    }
    if (
      proposal.operation === "update" &&
      (proposal.before === undefined || proposal.after === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "An update proposal requires before and after",
      });
    }
    if (
      proposal.operation === "delete" &&
      (proposal.before === undefined || proposal.after !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "A delete proposal requires before and must not have after",
      });
    }
  });

export type MemoryMutationProposal = z.infer<typeof memoryMutationProposalSchema>;

export interface MemoryMutationPreview {
  readonly operation: MemoryMutationOperation;
  readonly scope: MemoryScope;
  readonly id: string;
  readonly expectedRevision: number;
  readonly before?: PersistentMemoryEntryV1;
  readonly after?: PersistentMemoryEntryV1;
  readonly source: MemorySource;
  readonly proposedAt: string;
}

export type MemoryProposalValidationError =
  | "invalid_input"
  | "not_found"
  | "duplicate"
  | "unchanged"
  | "capacity_exceeded"
  | "store_unavailable";

export const MEMORY_ERROR_CODES = Object.freeze({
  invalidInput: "invalid_input",
  notFound: "not_found",
  duplicate: "duplicate",
  unchanged: "unchanged",
  capacityExceeded: "capacity_exceeded",
  storeUnavailable: "store_unavailable",
  notConfirmed: "not_confirmed",
  confirmationUnavailable: "confirmation_unavailable",
  conflict: "conflict",
} as const);

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[keyof typeof MEMORY_ERROR_CODES];

export class PersistentMemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PersistentMemoryError";
  }
}
