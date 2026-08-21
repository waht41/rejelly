import { augmentTool, equipTool, type ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import type {
  MemoryConfirmationHandler,
  MemoryMutationConfirmationPayload,
} from "../../../shared/host/toolConfirmationBindings";
import { evilJellyToolLoggerMiddleware } from "../../../shared/tool-observation/middleware";
import {
  type MemoryAddInput,
  type MemoryListInput,
  memoryDetailSchema,
  memoryIdSchema,
  memoryScopeSchema,
  memorySummarySchema,
  memoryTitleSchema,
} from "../model/memorySchema";
import type { SessionMemoryRuntime } from "../runtime/sessionMemoryRuntime";
import {
  type MemoryMutationPreview,
  PersistentMemoryError,
} from "../service/memoryMutationProposal";
import type {
  MemorySourceContext,
  PersistentMemoryService,
} from "../service/persistentMemoryService";
import { createPersistentMemoryService } from "../service/persistentMemoryServiceImpl";

const memoryReadParameters = z
  .object({
    scope: z.enum(["all", "user", "project"]).default("all"),
    ids: z.array(memoryIdSchema).max(20).optional(),
    view: z.enum(["catalog", "detail"]).default("catalog"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ids && new Set(value.ids).size !== value.ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ids"],
        message: "Memory ids must be unique",
      });
    }
    if (value.view === "detail" && value.ids === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ids"],
        message: "Detail view requires explicit memory ids",
      });
    }
    if (value.view === "catalog" && value.ids !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ids"],
        message: "Catalog view does not accept memory ids; use detail view",
      });
    }
  });

export type MemoryReadInput = z.input<typeof memoryReadParameters>;

const memoryEditChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add"),
      scope: memoryScopeSchema.optional(),
      title: memoryTitleSchema,
      summary: memorySummarySchema,
      detail: memoryDetailSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("update"),
      id: memoryIdSchema,
      title: memoryTitleSchema.optional(),
      summary: memorySummarySchema.optional(),
      detail: memoryDetailSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      id: memoryIdSchema,
    })
    .strict(),
]);

const memoryEditParameters = z
  .object({
    change: memoryEditChangeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.change.kind === "update" &&
      value.change.title === undefined &&
      value.change.summary === undefined &&
      value.change.detail === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["change"],
        message: "Memory update must change at least one field",
      });
    }
  });

export type MemoryEditInput = z.input<typeof memoryEditParameters>;

export interface MemoryToolsOptions {
  readonly service: PersistentMemoryService;
  readonly runtime?: SessionMemoryRuntime;
  readonly source: MemorySourceContext;
  /** Missing handlers are intentionally treated as unavailable, never as acceptance. */
  readonly requestConfirmation?: MemoryConfirmationHandler;
}

function publicError(error: unknown): { status: "error"; code: string; message: string } {
  if (error instanceof PersistentMemoryError) {
    const code = error.code === "store_unavailable" ? "store_unavailable" : error.code;
    return {
      status: "error",
      code,
      message:
        error.code === "store_unavailable"
          ? "Persistent memory is temporarily unavailable."
          : error.message,
    };
  }
  if (error instanceof z.ZodError) {
    return { status: "error", code: "invalid_input", message: error.message };
  }
  return {
    status: "error",
    code: "store_unavailable",
    message: "Persistent memory is unavailable.",
  };
}

function confirmationPayload(
  preview: MemoryMutationPreview & { proposalSha256: string },
): MemoryMutationConfirmationPayload {
  const projectEntry = (
    entry: MemoryMutationPreview["before"],
  ): NonNullable<MemoryMutationConfirmationPayload["before"]> | undefined =>
    entry
      ? {
          id: entry.id,
          scope: entry.scope,
          title: entry.title,
          summary: entry.summary,
          detail: entry.detail,
          revision: entry.revision,
        }
      : undefined;
  return {
    type: "memory_mutation",
    operation: preview.operation,
    scope: preview.scope,
    id: preview.id,
    expectedRevision: preview.expectedRevision,
    ...(preview.before ? { before: projectEntry(preview.before) } : {}),
    ...(preview.after ? { after: projectEntry(preview.after) } : {}),
    proposalSha256: preview.proposalSha256,
    source: {
      source: "agent_tool",
      ...(preview.source.sessionId ? { sessionId: preview.source.sessionId } : {}),
      ...(preview.source.turnId ? { turnId: preview.source.turnId } : {}),
    },
  };
}

async function executeMemoryEdit(
  input: MemoryEditInput,
  options: MemoryToolsOptions,
): Promise<Record<string, unknown>> {
  try {
    const change = input.change;
    const proposal =
      change.kind === "add"
        ? await options.service.proposeAdd(
            {
              title: change.title,
              summary: change.summary,
              detail: change.detail,
              scope: change.scope,
            } satisfies MemoryAddInput,
            options.source,
          )
        : change.kind === "update"
          ? await options.service.proposeUpdate(
              {
                id: change.id,
                ...(change.title !== undefined ? { title: change.title } : {}),
                ...(change.summary !== undefined ? { summary: change.summary } : {}),
                ...(change.detail !== undefined ? { detail: change.detail } : {}),
              },
              options.source,
            )
          : await options.service.proposeDelete({ id: change.id }, options.source);

    const preview = {
      operation: proposal.operation,
      scope: proposal.scope,
      id: proposal.id,
      expectedRevision: proposal.expectedRevision,
      before: proposal.before,
      after: proposal.after,
      source: proposal.source,
      proposedAt: proposal.proposedAt,
    } satisfies MemoryMutationPreview;
    const proposalSha256 = proposal.proposalSha256;
    const confirmation = options.requestConfirmation
      ? await options.requestConfirmation(confirmationPayload({ ...preview, proposalSha256 }))
      : { action: "unavailable" as const, reason: "Memory confirmation is unavailable." };

    if (confirmation.action === "reject") {
      return {
        status: "not_confirmed",
        code: "not_confirmed",
        id: proposal.id,
        scope: proposal.scope,
        proposalSha256,
      };
    }
    if (confirmation.action === "unavailable") {
      return {
        status: "not_confirmed",
        code: "confirmation_unavailable",
        id: proposal.id,
        scope: proposal.scope,
        proposalSha256,
      };
    }

    const result = await options.service.commitConfirmed(proposal, {
      proposalSha256,
      confirmedAt: new Date().toISOString(),
      confirmedBy: "user",
      confirmationSurface: "interactive_prompt",
    });
    return {
      ...result,
      ...(result.entry ? { entry: result.entry } : {}),
      ...(result.status === "committed" ? { instructionEffect: "next_epoch" } : {}),
    };
  } catch (error) {
    return publicError(error);
  }
}

export function createMemoryReadTool(
  service: PersistentMemoryService,
  runtime?: SessionMemoryRuntime,
): ToolDefinition<typeof memoryReadParameters> {
  return {
    name: "memory_read",
    description:
      "Read persistent memory. Without ids, read the live catalog; with ids and view=detail, read selected memory details and provenance. " +
      "Use only when the user explicitly asks to inspect or refresh memory.",
    parameters: memoryReadParameters,
    handler: async (input) => {
      try {
        const listInput: MemoryListInput = {
          scope: input.scope,
          ...(input.ids ? { ids: input.ids } : {}),
          view: input.view === "detail" ? "detail" : "summary",
        };
        const result = await service.list(listInput);
        const entries =
          input.view === "detail"
            ? result.entries
            : result.entries.map((entry) => ({
                id: entry.id,
                scope: entry.scope,
                title: entry.title,
                summary: entry.summary,
                revision: entry.revision,
              }));
        return {
          status: result.status,
          scope: result.scope,
          view: input.view,
          entries: entries.map((entry) => ({
            ...entry,
            ...(runtime
              ? {
                  injectedStatus: runtime.statusFor(
                    entry.id,
                    result.entries.find((candidate) => candidate.id === entry.id),
                  ),
                }
              : {}),
          })),
          ...(result.status === "unavailable"
            ? { diagnostic: "One or more persistent memory scopes are unavailable." }
            : {}),
        };
      } catch (error) {
        return publicError(error);
      }
    },
  };
}

export function createMemoryEditTool(
  options: MemoryToolsOptions,
): ToolDefinition<typeof memoryEditParameters> {
  return {
    name: "memory_edit",
    description:
      "Propose one persistent memory add, update, or delete. The host must independently confirm the exact proposal before anything is written; never provide confirmation flags.",
    parameters: memoryEditParameters,
    handler: async (input) => executeMemoryEdit(input, options),
  };
}

export function createMemoryTools(
  options: MemoryToolsOptions,
): [ToolDefinition<typeof memoryReadParameters>, ToolDefinition<typeof memoryEditParameters>] {
  return [createMemoryReadTool(options.service, options.runtime), createMemoryEditTool(options)];
}

export interface EquipMemoryKitOptions {
  readonly workspaceRoot: string;
  readonly source: MemorySourceContext;
  readonly memoryRoot?: string;
  readonly service?: PersistentMemoryService;
  readonly runtime?: SessionMemoryRuntime;
  readonly requestConfirmation?: MemoryConfirmationHandler;
}

/** Equip the only two model-facing persistent-memory capabilities. */
export function equipMemoryKit(options: EquipMemoryKitOptions): void {
  const service =
    options.service ??
    createPersistentMemoryService({
      workspaceRoot: options.workspaceRoot,
      ...(options.memoryRoot ? { memoryRoot: options.memoryRoot } : {}),
    });
  const tools: ToolDefinition[] = createMemoryTools({
    service: options.runtime?.service ?? service,
    runtime: options.runtime,
    source: options.source,
    requestConfirmation: options.requestConfirmation,
  }) as unknown as ToolDefinition[];
  for (const tool of tools) {
    equipTool(augmentTool(tool, [evilJellyToolLoggerMiddleware]));
  }
}

export { memoryEditParameters, memoryReadParameters };
