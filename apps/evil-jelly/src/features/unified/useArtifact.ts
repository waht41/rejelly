import { randomUUID } from "node:crypto";
import type { MessageContent, ToolDefinition } from "@rejelly/core";
import { equipMemory, equipTool, equipToolCallLoopMiddleware } from "@rejelly/core";
import { z } from "zod";
import { UNIFIED_TOOL_ARTIFACTS_KEY } from "./unifiedMemoryKeys";

const DEFAULT_MAX_ARTIFACTS = 12;

type ArtifactStore = Record<string, string>;

function touchArtifact(store: ArtifactStore, artifactId: string): ArtifactStore {
  const content = store[artifactId];
  if (typeof content !== "string") {
    return store;
  }
  const { [artifactId]: _removed, ...rest } = store;
  return {
    ...rest,
    [artifactId]: content,
  };
}

function trimArtifactsByLru(store: ArtifactStore, maxArtifacts: number): ArtifactStore {
  const entries = Object.entries(store);
  if (entries.length <= maxArtifacts) {
    return store;
  }
  return Object.fromEntries(entries.slice(-maxArtifacts));
}

const readArtifactParameters = z.object({
  artifactId: z.string().min(1),
});

function createReadArtifactTool(
  maxArtifacts: number,
): ToolDefinition<typeof readArtifactParameters> {
  return {
    name: "readArtifact",
    description:
      "Read the full output of a previously truncated tool call using an artifactId from the system hint.",
    parameters: readArtifactParameters,
    handler: async ({ artifactId }) => {
      const [artifacts, setArtifacts] = equipMemory<ArtifactStore>(UNIFIED_TOOL_ARTIFACTS_KEY, {});
      const fullContent = artifacts[artifactId];
      if (typeof fullContent !== "string") {
        return `Error: Artifact ID "${artifactId}" not found.`;
      }
      // Refresh LRU order when an artifact is accessed by readArtifact.
      const touchedArtifacts = touchArtifact(artifacts, artifactId);
      setArtifacts(trimArtifactsByLru(touchedArtifacts, maxArtifacts));
      return fullContent;
    },
  };
}

function readMessageText(content: MessageContent | null): string | null {
  if (content === null) {
    return null;
  }
  if (typeof content === "string") {
    return content;
  }
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  return text.length > 0 ? text : null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Records each tool call + result into artifact memory; current outputs stay unchanged. */
export function useArtifact(options?: { name?: string; maxArtifacts?: number }): void {
  const middlewareName = options?.name ?? "evil-jelly-unified-artifact-loop";
  const maxArtifacts = Math.max(1, options?.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS);
  let writeQueue = Promise.resolve();

  const [existingArtifacts] = equipMemory<ArtifactStore>(UNIFIED_TOOL_ARTIFACTS_KEY, {});
  if (Object.keys(existingArtifacts).length > 0) {
    equipTool(createReadArtifactTool(maxArtifacts));
  }

  equipToolCallLoopMiddleware({
    name: middlewareName,
    handler: async (_ctx, calls, next) => {
      const outputs = await next(calls);

      await Promise.all(
        outputs.map(async (out, index) => {
          const resultText = readMessageText(out.content) ?? stringifyUnknown(out.content);
          const callText = stringifyUnknown(calls[index] ?? null);
          const artifactId = `artifact_${randomUUID().slice(0, 8)}`;
          await new Promise<void>((resolve) => {
            writeQueue = writeQueue.then(() => {
              const [artifacts, setArtifacts] = equipMemory<ArtifactStore>(
                UNIFIED_TOOL_ARTIFACTS_KEY,
                {},
              );
              const nextArtifacts = trimArtifactsByLru(
                {
                  ...artifacts,
                  [artifactId]: `call:\n${callText}\n\nresult:\n${resultText}`,
                },
                maxArtifacts,
              );
              setArtifacts({
                ...nextArtifacts,
              });
              resolve();
            });
          });
        }),
      );

      return outputs;
    },
  });
}
