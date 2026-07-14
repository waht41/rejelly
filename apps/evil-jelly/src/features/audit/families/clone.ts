/**
 * Clone seed family: token-level duplicate-code detection (Phase 1) + the declaration-only pre-filter
 * (INV-0008 §2.3) + the clone identity adapter + the clone evaluator, wired into the generic driver.
 *
 * Ordered top-down: seed view → identity adapter (ledger fingerprint) → prompt builder →
 * evaluator agent (Phase 2, agentic precision layer) → family export (registered in AuditAgent).
 *
 * cloneSeedFilter.ts stays a sibling file — it has its own test surface and an independent reason-to-change.
 */

import type { z } from "zod";
import type { CloneCluster, CloneFragment } from "../../../services/clone";
import { detectCloneCandidates } from "../../../services/clone";
import { PromptBuilder } from "../../../services/prompt/PromptBuilder";
import {
  compareString,
  createAuditSourceSnapshotReader,
  fencedCodeBlock,
  normalizeAuditSourceFallback,
  readCappedLineSlice,
  sliceAuditSourceLines,
  tokensInLineRange,
} from "../familySource";
import { sha256 } from "../runtime/ledger";
import { makeSeedEvaluatorAgent, makeVerdictSchema } from "../seedEvaluator";
import type {
  AuditFamilyStats,
  AuditSeed,
  AuditSeedFamily,
  AuditSeedIdentity,
  PreparedSeed,
} from "../types";
import { AUDIT_DEFAULTS } from "../types";
import { filterBehavioralSeeds } from "./cloneSeedFilter";

// ---------------------------------------------------------------------------
// Seed view — family-agnostic view of one detector candidate
// ---------------------------------------------------------------------------

function cloneSeedView(cluster: CloneCluster): AuditSeed {
  return {
    kind: "clone",
    id: cluster.id,
    locations: cluster.fragments.map((f) => ({
      file: f.file,
      startLine: f.startLine,
      endLine: f.endLine,
      lines: f.lines,
    })),
    fileCount: cluster.fileCount,
    weight: cluster.maxLines,
    label: `${cluster.fragments.length} fragment(s) · ${cluster.fileCount} file(s)`,
  };
}

// ---------------------------------------------------------------------------
// Identity adapter — stable fingerprint + content hash for the shared ledger
// ---------------------------------------------------------------------------

/**
 * `fingerprint` is intentionally less sensitive than `contentHash`: it uses normalized tokens so
 * line moves, whitespace, identifier renames and literal tweaks do not create a brand-new finding.
 * `contentHash` uses the raw current slices so changed code gets re-evaluated.
 */

export interface CloneIdentityResolver {
  identityFor(cluster: CloneCluster): Promise<AuditSeedIdentity>;
}

/** Create a per-run resolver so repeated clusters do not re-read or re-parse the same file. */
export function createCloneIdentityResolver(): CloneIdentityResolver {
  const snapshotFor = createAuditSourceSnapshotReader();

  return {
    async identityFor(cluster) {
      const fragments = [...cluster.fragments].sort(
        (a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine,
      );
      const fragmentShapes: string[] = [];
      const contentSlices: string[] = [];

      for (const fragment of fragments) {
        const snapshot = await snapshotFor(fragment.file);
        const raw = sliceAuditSourceLines(snapshot.lines, fragment);
        const normalized =
          snapshot.tokens && snapshot.tokens.length > 0
            ? tokensInLineRange(snapshot.tokens, fragment)
            : normalizeAuditSourceFallback(raw);
        fragmentShapes.push(
          `${fragment.file}:${sha256(normalized || normalizeAuditSourceFallback(raw))}`,
        );
        contentSlices.push(`${fragment.file}:${sha256(raw)}`);
      }

      const files = [...new Set(fragments.map((f) => f.file))].sort(compareString);
      const fingerprint = sha256(
        JSON.stringify({
          kind: "clone",
          files,
          fragmentCount: fragments.length,
          shapes: fragmentShapes.sort(compareString),
        }),
      ).slice(0, 24);
      const contentHash = sha256(
        JSON.stringify({
          kind: "clone",
          slices: contentSlices.sort(compareString),
        }),
      );

      return {
        id: `clone:${fingerprint}`,
        kind: "clone",
        fingerprint,
        contentHash,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builder — per-seed evaluator instruction (embeds the candidate's source)
// ---------------------------------------------------------------------------

/** Fenced code block tagged with the file and line range for one fragment. */
async function renderFragmentBlock(fragment: CloneFragment, maxLines: number): Promise<string> {
  const header = `${fragment.file}:${fragment.startLine}-${fragment.endLine} (${fragment.lines} lines)`;
  const slice = await readCappedLineSlice(fragment.file, fragment, maxLines);
  if (slice === null) {
    return `### ${header}\n(could not read source)`;
  }
  return `### ${header}\n${fencedCodeBlock(fragment.file, slice)}`;
}

/**
 * Instruction block for the evaluator: the candidate's fragments (with source) plus the framing that
 * this is a recall-oriented detector output to be judged, not a confirmed finding.
 */
export async function buildCloneInstruction(cluster: CloneCluster): Promise<string> {
  const fragments = cluster.fragments.slice(0, AUDIT_DEFAULTS.maxFragmentsPerSeed);
  const blocks = await Promise.all(
    fragments.map((f) => renderFragmentBlock(f, AUDIT_DEFAULTS.maxFragmentLines)),
  );
  const omitted = cluster.fragments.length - fragments.length;

  return new PromptBuilder()
    .addBlock(
      `A deterministic token-level clone detector grouped these ${cluster.fragments.length} code ` +
        `fragments across ${cluster.fileCount} file(s) as a duplication candidate (cluster ${cluster.id}). ` +
        "Identifiers and literals were normalized, so the match is structural — it may be genuine " +
        "duplication or a coincidental/boilerplate shape. Judge it.",
    )
    .addBlock(blocks.join("\n\n"))
    .addBlock(
      omitted > 0 ? `(${omitted} further fragment(s) in this cluster were omitted.)` : false,
    )
    .addList(
      [
        "Decide isActionable: is the shared logic genuinely the same intent, and worth consolidating?",
        "If yes, give a concrete proposal: what to extract, which layer/module it belongs in, how callers change.",
        "If no (coincidental match, framework boilerplate, or intentional), say why and set category=leave-as-is.",
        "You may use read-only tools for surrounding context, but the slices above are usually enough — stay cheap.",
      ],
      { title: "Do:", style: "bullet" },
    )
    .build();
}

// ---------------------------------------------------------------------------
// Evaluator — per-seed agentic precision layer (Phase 2)
// ---------------------------------------------------------------------------

export const CloneVerdictSchema = makeVerdictSchema({
  actionableDescribe:
    "True only if these fragments are genuine, semantically equivalent logic that is worth " +
    "consolidating. False for coincidental token matches, framework/boilerplate shape " +
    "(config objects, switch arms, simple delegations), or duplication that is intentional and " +
    "clearer left apart.",
  categories: [
    "extract-function",
    "extract-module",
    "consolidate-callers",
    "parameterize",
    "data-driven",
    "inline",
    "leave-as-is",
  ],
  categoryDescribe:
    "The refactor shape that best resolves this duplication; leave-as-is when not real.",
});

const SYSTEM_PROMPT = new PromptBuilder()
  .addBlock(
    "You are a senior code-duplication auditor. You receive one CANDIDATE cluster of code fragments " +
      "that a deterministic token-level detector grouped as structurally similar. Your job is judgment, " +
      "not detection: decide whether this is real duplication worth consolidating, and if so design the refactor.",
  )
  .addList(
    [
      "The detector normalizes identifiers/literals, so it flags shape, not meaning. Coincidental matches " +
        "(config object literals, switch/case arms, validation boilerplate, trivial delegations) are common — reject them.",
      "Real duplication = the SAME behavior/intent expressed more than once, where a future change would have to " +
        "be made in every copy (drift/bug risk). That is what you flag.",
      "Be concrete and grounded in the shown code. Do not invent helpers or files you have not seen.",
      "Refactor proposals must respect the layering cascade (cli → shell → feature → tools → service → shared): " +
        "shared logic belongs in a lower layer than its callers.",
      "Prefer the smallest honest answer. When unsure, lean leave-as-is rather than over-abstracting.",
    ],
    { title: "Principles:", style: "bullet" },
  )
  .addBlock(
    "Return the structured verdict. Keep summary/rationale/proposal as plain prose (no code fences, no JSON).",
  )
  .build();

/** Clone-family evaluator agent. Call as `CloneEvaluatorAgent({ native: cluster })`. */
export const CloneEvaluatorAgent = makeSeedEvaluatorAgent<
  CloneCluster,
  z.infer<typeof CloneVerdictSchema>
>({
  id: "audit_clone_evaluator_agent",
  systemPrompt: SYSTEM_PROMPT,
  buildInstruction: (cluster) => buildCloneInstruction(cluster),
  schema: CloneVerdictSchema,
});

// ---------------------------------------------------------------------------
// Family export — registered in AuditAgent
// ---------------------------------------------------------------------------

export const cloneFamily: AuditSeedFamily = {
  kind: "clone",
  label: "Code duplication",
  async collect() {
    const detection = await detectCloneCandidates();
    // §2.3 deterministic pre-filter: strip declaration/schema/config fragments; drop clusters left
    // with <2 behavioral fragments so the LLM is not spent confirming framework boilerplate.
    const { kept, dropped } = await filterBehavioralSeeds(detection.clusters);

    const resolver = createCloneIdentityResolver();
    const prepared: PreparedSeed[] = await Promise.all(
      kept.map(async (cluster) => ({
        seed: cloneSeedView(cluster),
        identity: await resolver.identityFor(cluster),
        evaluate: () => CloneEvaluatorAgent({ native: cluster }),
      })),
    );

    const stats: AuditFamilyStats = {
      kind: "clone",
      label: "Code duplication",
      filesScanned: detection.stats.filesScanned,
      filesParsed: detection.stats.filesParsed,
      candidatesFound: detection.clusters.length,
      preFiltered: dropped.length,
    };
    return { prepared, stats };
  },
};
