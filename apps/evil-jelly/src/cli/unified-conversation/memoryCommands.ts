import { z } from "zod";
import {
  memoryDetailSchema,
  memoryIdSchema,
  memorySummarySchema,
  memoryTitleSchema,
  type PersistentMemoryEntryV1,
} from "../../domains/memory/model/memorySchema";
import type {
  MemoryInjectedStatus,
  SessionMemoryRuntime,
} from "../../domains/memory/runtime/sessionMemoryRuntime";
import type { MemoryMutationProposal } from "../../domains/memory/service/memoryMutationProposal";
import { PersistentMemoryError } from "../../domains/memory/service/memoryMutationProposal";
import type {
  MemorySourceContext,
  PersistentMemoryService,
} from "../../domains/memory/service/persistentMemoryService";
import type {
  MemoryConfirmationHandler,
  MemoryMutationConfirmationPayload,
} from "../../shared/host/toolConfirmationBindings";

export interface MemoryCommandPorts {
  readonly service: PersistentMemoryService;
  readonly runtime?: SessionMemoryRuntime;
  readonly sessionId?: string;
  readonly requestConfirmation?: MemoryConfirmationHandler;
  logSystem(message: string): void;
}

type MemoryCommand =
  | { kind: "catalog" }
  | { kind: "show"; id: string }
  | { kind: "edit"; id: string; field: "title" | "summary" | "detail"; value: string }
  | { kind: "delete"; id: string }
  | { kind: "invalid"; message: string };

const fields = new Set(["title", "summary", "detail"]);

function parseMemoryCommand(rawInput: string): MemoryCommand | null {
  const args = rawInput.trim().split(/\s+/);
  if (args[0]?.toLocaleLowerCase() !== "/memory") return null;
  if (args.length === 1) return { kind: "catalog" };

  const action = args[1]?.toLocaleLowerCase();
  if (action === "show") {
    return args.length === 3 && args[2]
      ? { kind: "show", id: args[2] }
      : { kind: "invalid", message: "Usage: /memory show <id>" };
  }
  if (action === "delete") {
    return args.length === 3 && args[2]
      ? { kind: "delete", id: args[2] }
      : { kind: "invalid", message: "Usage: /memory delete <id>" };
  }
  if (action === "edit") {
    if (args.length < 5 || !args[2] || !args[3] || !fields.has(args[3])) {
      return {
        kind: "invalid",
        message: "Usage: /memory edit <id> <title|summary|detail> <new-value>",
      };
    }
    const value = args.slice(4).join(" ").trim();
    return value
      ? {
          kind: "edit",
          id: args[2],
          field: args[3] as "title" | "summary" | "detail",
          value,
        }
      : {
          kind: "invalid",
          message: "Usage: /memory edit <id> <title|summary|detail> <new-value>",
        };
  }
  return null;
}

export function isMemoryLocalCommand(rawInput: string): boolean {
  return parseMemoryCommand(rawInput) !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function statusLabel(status: MemoryInjectedStatus): string {
  return status === "current"
    ? "current"
    : status === "pending_next_epoch"
      ? "pending next epoch"
      : "removed next epoch";
}

function entryStatus(runtime: SessionMemoryRuntime | undefined, entry: PersistentMemoryEntryV1) {
  return runtime ? statusLabel(runtime.statusFor(entry.id, entry)) : "unavailable";
}

function sortedEntries(entries: readonly PersistentMemoryEntryV1[]): PersistentMemoryEntryV1[] {
  return [...entries].sort(
    (left, right) =>
      (left.scope === right.scope ? 0 : left.scope === "user" ? -1 : 1) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
  );
}

function formatCatalog(
  entries: readonly PersistentMemoryEntryV1[],
  runtime: SessionMemoryRuntime | undefined,
): string {
  const liveEntries = sortedEntries(entries);
  const removedEntries = runtime
    ? runtime.epoch.entries.filter((frozen) => !entries.some((entry) => entry.id === frozen.id))
    : [];
  const sections = (["user", "project"] as const).map((scope) => {
    const scopedLive = liveEntries.filter((entry) => entry.scope === scope);
    const scopedRemoved = removedEntries.filter((entry) => entry.scope === scope);
    const lines = [
      ...scopedLive.map(
        (entry) =>
          `- [${entry.id}] ${entry.title} — ${entry.summary} (revision ${entry.revision}, updated ${formatTimestamp(entry.updatedAt)}, injected: ${entryStatus(runtime, entry)})`,
      ),
      ...scopedRemoved.map(
        (entry) =>
          `- [${entry.id}] ${entry.title} — ${entry.summary} (revision —, updated —, injected: removed next epoch)`,
      ),
    ];
    return `${scope === "user" ? "User Memory" : "Project Memory"}\n${lines.length > 0 ? lines.join("\n") : "- (none)"}`;
  });
  return `Persistent Memory\n\n${sections.join("\n\n")}\n`;
}

function formatProvenance(entry: PersistentMemoryEntryV1): string {
  return JSON.stringify(entry.provenance, null, 2);
}

function formatDetail(
  entry: PersistentMemoryEntryV1,
  runtime: SessionMemoryRuntime | undefined,
): string {
  return [
    `Memory ${entry.id}`,
    `Scope: ${entry.scope}`,
    `Title: ${entry.title}`,
    `Summary: ${entry.summary}`,
    `Detail:\n${entry.detail}`,
    `Revision: ${entry.revision}`,
    `Created: ${formatTimestamp(entry.createdAt)}`,
    `Updated: ${formatTimestamp(entry.updatedAt)}`,
    `Injected: ${entryStatus(runtime, entry)}`,
    `Provenance:\n${formatProvenance(entry)}`,
    "",
  ].join("\n");
}

function previewEntry(
  entry: PersistentMemoryEntryV1 | undefined,
): MemoryMutationConfirmationPayload["before"] {
  return entry
    ? {
        id: entry.id,
        scope: entry.scope,
        title: entry.title,
        summary: entry.summary,
        detail: entry.detail,
        revision: entry.revision,
      }
    : undefined;
}

function confirmationPayload(proposal: MemoryMutationProposal): MemoryMutationConfirmationPayload {
  return {
    type: "memory_mutation",
    operation: proposal.operation,
    scope: proposal.scope,
    id: proposal.id,
    expectedRevision: proposal.expectedRevision,
    ...(proposal.before ? { before: previewEntry(proposal.before) } : {}),
    ...(proposal.after ? { after: previewEntry(proposal.after) } : {}),
    proposalSha256: proposal.proposalSha256,
    source: {
      source: "slash_command",
      ...(proposal.source.sessionId ? { sessionId: proposal.source.sessionId } : {}),
      ...(proposal.source.turnId ? { turnId: proposal.source.turnId } : {}),
    },
  };
}

function usageForInvalidInput(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Memory command failed: ${error.issues[0]?.message ?? "invalid value"}`;
  }
  return `Memory command failed: ${errorMessage(error)}`;
}

async function showCatalog(ports: MemoryCommandPorts): Promise<void> {
  const result = await ports.service.list({ scope: "all", view: "summary" });
  ports.logSystem(formatCatalog(result.entries, ports.runtime));
  if (result.diagnostic) ports.logSystem(`Memory warning: ${result.diagnostic}\n`);
}

async function showEntry(ports: MemoryCommandPorts, id: string): Promise<void> {
  const parsedId = memoryIdSchema.safeParse(id);
  if (!parsedId.success) {
    ports.logSystem("Memory command failed: invalid memory id.\n");
    return;
  }
  const result = await ports.service.list({ scope: "all", ids: [parsedId.data], view: "detail" });
  const entry = result.entries[0];
  if (!entry) {
    ports.logSystem(`Memory not found: ${id}\n`);
    return;
  }
  ports.logSystem(`${formatDetail(entry, ports.runtime)}\n`);
}

async function requestAndCommit(
  ports: MemoryCommandPorts,
  proposal: MemoryMutationProposal,
): Promise<void> {
  if (!ports.requestConfirmation) {
    ports.logSystem("Memory change not applied: interactive confirmation is unavailable.\n");
    return;
  }
  const decision = await ports.requestConfirmation(confirmationPayload(proposal));
  if (decision.action === "reject") {
    ports.logSystem(`Memory ${proposal.operation} rejected; nothing was changed.\n`);
    return;
  }
  if (decision.action === "unavailable") {
    ports.logSystem(`Memory change not applied: ${decision.reason}\n`);
    return;
  }
  const result = await ports.service.commitConfirmed(proposal, {
    proposalSha256: proposal.proposalSha256,
    confirmedAt: new Date().toISOString(),
    confirmedBy: "user",
    confirmationSurface: "interactive_prompt",
  });
  if (result.status !== "committed") {
    ports.logSystem(
      `Memory ${proposal.operation} was not committed (${result.code ?? result.status}); the memory may have changed since confirmation.\n`,
    );
    return;
  }
  ports.logSystem(
    `Memory ${proposal.operation} committed: ${proposal.id}. The injected catalog will update at the next session or compaction boundary.\n`,
  );
}

async function editEntry(
  ports: MemoryCommandPorts,
  id: string,
  field: "title" | "summary" | "detail",
  value: string,
): Promise<void> {
  const parsedId = memoryIdSchema.safeParse(id);
  const schema =
    field === "title"
      ? memoryTitleSchema
      : field === "summary"
        ? memorySummarySchema
        : memoryDetailSchema;
  const parsedValue = schema.safeParse(value);
  if (!parsedId.success || !parsedValue.success) {
    ports.logSystem(usageForInvalidInput(parsedId.success ? parsedValue.error : parsedId.error));
    return;
  }
  const source: MemorySourceContext = {
    source: "slash_command",
    ...(ports.sessionId ? { sessionId: ports.sessionId } : {}),
  };
  const proposal = await ports.service.proposeUpdate(
    { id: parsedId.data, [field]: parsedValue.data },
    source,
  );
  await requestAndCommit(ports, proposal);
}

async function deleteEntry(ports: MemoryCommandPorts, id: string): Promise<void> {
  const parsedId = memoryIdSchema.safeParse(id);
  if (!parsedId.success) {
    ports.logSystem("Memory command failed: invalid memory id.\n");
    return;
  }
  const source: MemorySourceContext = {
    source: "slash_command",
    ...(ports.sessionId ? { sessionId: ports.sessionId } : {}),
  };
  const proposal = await ports.service.proposeDelete({ id: parsedId.data }, source);
  await requestAndCommit(ports, proposal);
}

export async function handleMemoryCommand(
  rawInput: string,
  ports: MemoryCommandPorts,
): Promise<void> {
  const command = parseMemoryCommand(rawInput);
  if (!command) return;
  if (command.kind === "invalid") {
    ports.logSystem(`${command.message}\n`);
    return;
  }
  try {
    if (command.kind === "catalog") return await showCatalog(ports);
    if (command.kind === "show") return await showEntry(ports, command.id);
    if (command.kind === "edit")
      return await editEntry(ports, command.id, command.field, command.value);
    await deleteEntry(ports, command.id);
  } catch (error) {
    if (error instanceof PersistentMemoryError) {
      ports.logSystem(`Memory command failed (${error.code}): ${error.message}\n`);
      return;
    }
    ports.logSystem(`Memory command failed: ${errorMessage(error)}\n`);
  }
}
