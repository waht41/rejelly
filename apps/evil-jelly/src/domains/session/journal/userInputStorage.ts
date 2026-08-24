import type {
  FrozenResolvedUserInputV1,
  FrozenUserInputNodeV1,
  ResolvedUserInputV1,
} from "../../../shared/model/prompt/frozenUserInput";
import { parseFrozenUserInputV1 } from "../model/frozenUserInput";
import { persistSessionBlob, type SessionBlobStoreOptions } from "./sessionBlobStore";

export interface FreezeResolvedUserInputOptions extends SessionBlobStoreOptions {
  /** First session-level image ordinal assigned to image occurrences in this input. */
  imageOrdinalStart?: number;
}

/** Persist image bytes first, then return the sole storage-shaped user-input fact. */
export async function freezeResolvedUserInput(
  input: ResolvedUserInputV1,
  options: FreezeResolvedUserInputOptions = {},
): Promise<FrozenResolvedUserInputV1> {
  if (input.version !== 1) throw new Error("Unsupported resolved user-input version");
  const imageOrdinalStart = options.imageOrdinalStart ?? 1;
  if (!Number.isInteger(imageOrdinalStart) || imageOrdinalStart < 1) {
    throw new Error("Image ordinal start must be a positive integer");
  }
  const images = new Map<string, ReturnType<typeof persistSessionBlob>>();
  const nodes: FrozenUserInputNodeV1[] = [];
  let imageOrdinal = imageOrdinalStart;

  for (const node of input.nodes) {
    if (node.kind !== "image") {
      nodes.push({ ...node });
      continue;
    }
    let pending = images.get(node.sourceId);
    if (!pending) {
      pending = persistSessionBlob(node.bytes, node.mediaType, options);
      images.set(node.sourceId, pending);
    }
    nodes.push({
      kind: "image",
      blob: await pending,
      detail: node.detail,
      imageOrdinal: imageOrdinal++,
    });
  }

  return parseFrozenUserInputV1({
    version: 1,
    kind: "resolved",
    nodes,
  }) as FrozenResolvedUserInputV1;
}
