import { z } from "zod";

export const PERSISTENT_MEMORY_SCHEMA_VERSION = 1 as const;

export const PERSISTENT_MEMORY_LIMITS = Object.freeze({
  maxEntries: 100,
  maxTitleCodePoints: 80,
  maxSummaryCodePoints: 240,
  maxDetailCodePoints: 4_000,
  maxTitleAndSummaryCodePoints: 12_000,
  maxDetailCodePointsTotal: 100_000,
  maxFileBytes: 256 * 1024,
} as const);

export const memoryScopeSchema = z.enum(["user", "project"]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memorySourceKindSchema = z.enum(["agent_tool", "slash_command"]);
export type MemorySourceKind = z.infer<typeof memorySourceKindSchema>;

export const memoryIdSchema = z
  .string()
  .regex(
    /^mem_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Memory id must be a lowercase mem_<UUIDv4> value",
  );

const utcTimestampSchema = z.string().datetime({ offset: false });

function boundedText(maxCodePoints: number, label: string): z.ZodType<string> {
  return z
    .string()
    .trim()
    .min(1, `${label} must not be empty`)
    .refine(
      (value) => [...value].length <= maxCodePoints,
      `${label} must be at most ${maxCodePoints} Unicode code points`,
    );
}

export const memoryTitleSchema = boundedText(
  PERSISTENT_MEMORY_LIMITS.maxTitleCodePoints,
  "Memory title",
);
export const memorySummarySchema = boundedText(
  PERSISTENT_MEMORY_LIMITS.maxSummaryCodePoints,
  "Memory summary",
);
export const memoryDetailSchema = boundedText(
  PERSISTENT_MEMORY_LIMITS.maxDetailCodePoints,
  "Memory detail",
);

export const memorySourceSchema = z
  .object({
    source: memorySourceKindSchema,
    sessionId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
  })
  .strict();
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryProvenanceSchema = z
  .object({
    source: memorySourceKindSchema,
    sessionId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    proposedAt: utcTimestampSchema,
    confirmedAt: utcTimestampSchema,
    confirmedBy: z.literal("user"),
    confirmationSurface: z.literal("interactive_prompt"),
    proposalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MemoryProvenanceV1 = z.infer<typeof memoryProvenanceSchema>;

export const persistentMemoryEntryV1Schema = z
  .object({
    id: memoryIdSchema,
    scope: memoryScopeSchema,
    title: memoryTitleSchema,
    summary: memorySummarySchema,
    detail: memoryDetailSchema,
    revision: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    provenance: z
      .object({
        created: memoryProvenanceSchema,
        lastModified: memoryProvenanceSchema,
      })
      .strict(),
  })
  .strict();
export type PersistentMemoryEntryV1 = z.infer<typeof persistentMemoryEntryV1Schema>;

const persistentMemoryFileShape = z
  .object({
    version: z.literal(PERSISTENT_MEMORY_SCHEMA_VERSION),
    entries: z.array(persistentMemoryEntryV1Schema).max(PERSISTENT_MEMORY_LIMITS.maxEntries),
  })
  .strict();

function addFileInvariantIssues(
  value: z.infer<typeof persistentMemoryFileShape>,
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const details = new Set<string>();
  let titleAndSummaryCodePoints = 0;
  let detailCodePoints = 0;

  for (const [index, entry] of value.entries.entries()) {
    if (ids.has(entry.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "id"],
        message: `Duplicate memory id: ${entry.id}`,
      });
    }
    ids.add(entry.id);

    if (details.has(entry.detail)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "detail"],
        message: "Memory detail must be unique within a scope",
      });
    }
    details.add(entry.detail);

    titleAndSummaryCodePoints += [...entry.title].length + [...entry.summary].length;
    detailCodePoints += [...entry.detail].length;
  }

  if (titleAndSummaryCodePoints > PERSISTENT_MEMORY_LIMITS.maxTitleAndSummaryCodePoints) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: `Title and summary content must total at most ${PERSISTENT_MEMORY_LIMITS.maxTitleAndSummaryCodePoints} Unicode code points`,
    });
  }
  if (detailCodePoints > PERSISTENT_MEMORY_LIMITS.maxDetailCodePointsTotal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: `Detail content must total at most ${PERSISTENT_MEMORY_LIMITS.maxDetailCodePointsTotal} Unicode code points`,
    });
  }
}

export const persistentMemoryFileV1Schema =
  persistentMemoryFileShape.superRefine(addFileInvariantIssues);
export type PersistentMemoryFileV1 = z.infer<typeof persistentMemoryFileV1Schema>;

function scopedMemoryFileSchema(scope: MemoryScope) {
  return persistentMemoryFileV1Schema.superRefine((value, context) => {
    for (const [index, entry] of value.entries.entries()) {
      if (entry.scope !== scope) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "scope"],
          message: `A ${scope} memory file cannot contain ${entry.scope} entries`,
        });
      }
    }
  });
}

export const userMemoryFileV1Schema = scopedMemoryFileSchema("user");
export const projectMemoryFileV1Schema = scopedMemoryFileSchema("project");

export function parseScopedMemoryFile(value: unknown, scope: MemoryScope): PersistentMemoryFileV1 {
  return (scope === "user" ? userMemoryFileV1Schema : projectMemoryFileV1Schema).parse(value);
}

export function assertMemoryFileByteLimit(value: PersistentMemoryFileV1): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > PERSISTENT_MEMORY_LIMITS.maxFileBytes) {
    throw new Error(
      `Persistent memory file must be at most ${PERSISTENT_MEMORY_LIMITS.maxFileBytes} bytes`,
    );
  }
}

export const memoryAddInputSchema = z
  .object({
    title: memoryTitleSchema,
    summary: memorySummarySchema,
    detail: memoryDetailSchema,
    scope: memoryScopeSchema.default("project"),
  })
  .strict();
export type MemoryAddInput = z.infer<typeof memoryAddInputSchema>;

export const memoryUpdateInputSchema = z
  .object({
    id: memoryIdSchema,
    title: memoryTitleSchema.optional(),
    summary: memorySummarySchema.optional(),
    detail: memoryDetailSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.title === undefined && value.summary === undefined && value.detail === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "Memory update must change at least one field",
      });
    }
  });
export type MemoryUpdateInput = z.infer<typeof memoryUpdateInputSchema>;

export const memoryDeleteInputSchema = z.object({ id: memoryIdSchema }).strict();
export type MemoryDeleteInput = z.infer<typeof memoryDeleteInputSchema>;

export const memoryListInputSchema = z
  .object({
    scope: z.enum(["all", "user", "project"]).default("all"),
    ids: z.array(memoryIdSchema).max(PERSISTENT_MEMORY_LIMITS.maxEntries).optional(),
    view: z.enum(["summary", "detail"]).default("summary"),
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
  });
export type MemoryListInput = z.infer<typeof memoryListInputSchema>;

export const memoryConfirmationSchema = z
  .object({
    proposalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedAt: utcTimestampSchema,
    confirmedBy: z.literal("user"),
    confirmationSurface: z.literal("interactive_prompt"),
  })
  .strict();
export type UserMemoryConfirmation = z.infer<typeof memoryConfirmationSchema>;
