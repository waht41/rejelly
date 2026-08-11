/**
 * Fragmentation seed family: single-consumer micro-cluster detection (Phase 1) + the fragmentation
 * identity adapter + the fragmentation evaluator, wired into the generic audit driver. This is the audit's
 * first graph-input family (INV-0008): clone and complexity cannot see it, so it is a new family, not an
 * extension. The §2.3 pre-filter drops barrel-hosted clusters — a host that is an `index.*` re-export is
 * intentional aggregation, not over-decomposition.
 *
 * Honest boundary: unlike clone/complexity (near-zero FP), "should these collapse?" is a judgment call,
 * so the detector is fuzzier and the precision layer carries more weight. v1 only catches *local*
 * over-decomposition; reverse dispersion (one job smeared across many dirs) needs co-change and is
 * post-launch (blocked by the launch git wipe).
 *
 * Ordered top-down: seed view → identity adapter → prompt builder → evaluator agent → family export.
 */

import type { z } from "zod";
import { PromptBuilder } from "../../../shared/lib/promptBuilder";
import type { FragmentationCluster } from "../detectors/fragmentation";
import { detectFragmentationCandidates } from "../detectors/fragmentation";
import { compareString, fencedCodeBlock, readCappedLineSlice } from "../familySource";
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

// ---------------------------------------------------------------------------
// Seed view — family-agnostic view of one detector candidate
// ---------------------------------------------------------------------------

function fragmentationSeedView(cluster: FragmentationCluster): AuditSeed {
  return {
    kind: "fragmentation",
    id: cluster.id,
    locations: cluster.members.map((m) => ({
      file: m.file,
      startLine: 1,
      endLine: Math.max(1, m.lines),
      lines: m.lines,
    })),
    fileCount: cluster.fileCount,
    weight: cluster.score,
    label: `${cluster.satelliteCount} satellite(s) → ${cluster.host}`,
  };
}

// ---------------------------------------------------------------------------
// Identity adapter — stable fingerprint + content hash for the shared ledger
// ---------------------------------------------------------------------------

/**
 * `fingerprint` keys on the sorted member set + a coarse size bucket, so adding/removing a member or a
 * large size shift starts a new finding, while small edits keep the ledger lineage (an accepted/suppressed
 * decision survives). `contentHash` carries each member's exact line count, so a real membership/size
 * change re-triggers evaluation. No file reads needed — the detector already measured every member.
 */
function fragmentationIdentity(cluster: FragmentationCluster): AuditSeedIdentity {
  const files = cluster.members.map((m) => m.file).sort(compareString);
  const sizeBucket = Math.floor(cluster.totalLines / 40);
  const fingerprint = sha256(JSON.stringify({ kind: "fragmentation", files, sizeBucket })).slice(
    0,
    24,
  );
  const contentHash = sha256(
    JSON.stringify({
      kind: "fragmentation",
      members: cluster.members.map((m) => `${m.file}:${m.lines}`).sort(compareString),
    }),
  );
  return { id: `fragmentation:${fingerprint}`, kind: "fragmentation", fingerprint, contentHash };
}

// ---------------------------------------------------------------------------
// Prompt builder — per-seed evaluator instruction (embeds the cluster's files)
// ---------------------------------------------------------------------------

/** Fenced block of one member file, labelled host vs. satellite with its single importer. */
async function renderMemberBlock(
  member: FragmentationCluster["members"][number],
  host: string,
): Promise<string> {
  const role = member.isHost ? "host" : `satellite (imported only by ${host})`;
  const header = `${member.file} — ${role} (${member.lines} lines)`;
  const slice = await readCappedLineSlice(
    member.file,
    { startLine: 1, endLine: Math.max(1, member.lines) },
    AUDIT_DEFAULTS.maxFragmentationMemberLines,
  );
  if (slice === null) {
    return `### ${header}\n(could not read source)`;
  }
  return `### ${header}\n${fencedCodeBlock(member.file, slice)}`;
}

export async function buildFragmentationInstruction(
  cluster: FragmentationCluster,
): Promise<string> {
  // Host first, then satellites, capped so a large cluster cannot blow the prompt budget.
  const ordered = [...cluster.members].sort(
    (a, b) => Number(b.isHost) - Number(a.isHost) || a.file.localeCompare(b.file),
  );
  const shown = ordered.slice(0, AUDIT_DEFAULTS.maxFragmentationFiles);
  const blocks = await Promise.all(shown.map((m) => renderMemberBlock(m, cluster.host)));
  const omitted = ordered.length - shown.length;

  return new PromptBuilder()
    .addBlock(
      `A deterministic detector found this cluster of ${cluster.fileCount} files in one feature: the ` +
        `host \`${cluster.host}\` plus ${cluster.satelliteCount} small "satellite" file(s), each imported ` +
        "by exactly one sibling/parent (its single consumer). This is a candidate for over-decomposition " +
        "— a single responsibility spread across separate tiny modules. Judge it.",
    )
    .addBlock(blocks.join("\n\n"))
    .addBlock(omitted > 0 ? `(${omitted} further member file(s) were omitted.)` : false)
    .addList(
      [
        "Decide isActionable: are these files really one cohesive unit artificially split apart, so a reader " +
          "must open several files to follow one job — or is each split a genuine boundary (independent test " +
          "surface, distinct reason-to-change, a layering edge, or real reuse) and clearer left apart?",
        "If actionable, propose how far to merge: fold every satellite into the host (merge-into-one), or fold " +
          "only the role-fragments back and keep the one file that is a true boundary (merge-partial).",
        "If each file earns its own existence, set category=leave-as-is and say which boundary justifies it.",
        "You may use read-only tools for surrounding context, but the files above are usually enough — stay cheap.",
      ],
      { title: "Do:", style: "bullet" },
    )
    .build();
}

// ---------------------------------------------------------------------------
// Evaluator — per-seed agentic precision layer (Phase 2)
// ---------------------------------------------------------------------------

export const FragmentationVerdictSchema = makeVerdictSchema({
  actionableDescribe:
    "True only if these files are genuinely one cohesive unit that was split apart for no real reason, " +
    "so consolidating them makes the code easier to follow. False when each split is a true boundary — " +
    "an independent test surface, a distinct reason-to-change, a layering edge, or real reuse.",
  categories: ["merge-into-one", "merge-partial", "leave-as-is"],
  categoryDescribe:
    "How far to consolidate: merge-into-one folds every satellite into the host; merge-partial folds the " +
    "role-fragments back but keeps the one file that is a real boundary; leave-as-is when the split is justified.",
});

const SYSTEM_PROMPT = new PromptBuilder()
  .addBlock(
    "You are a senior architecture reviewer focused on over-decomposition (a single responsibility chopped " +
      "into several tiny files). You receive one CANDIDATE cluster: a host plus satellite files each imported " +
      "by only one sibling/parent. Your job is judgment, not detection: decide whether collapsing them genuinely " +
      "improves the code, and if so how far to merge.",
  )
  .addList(
    [
      "A file should exist as its own module only at a real boundary: an independent test surface, a distinct " +
        "reason-to-change, a layering edge (cli → shell → feature → tools → service → shared), or genuine reuse. " +
        "Splitting merely by role (prompt / evaluator / types / helper) when one consumer owns all of them is the smell.",
      "Actionable = a reader must hop across several files to understand or change one job, and the satellites have " +
        "no independent reason to exist. Then named functions + section comments in one file read better.",
      "Reject candidates where a split is justified: a satellite with its own tests, a clear layering edge, or a unit " +
        "likely to gain other consumers. Small + single-consumer is not automatically wrong.",
      "Be concrete and grounded in the shown files. Name which satellites fold into the host and which (if any) stay.",
      "Prefer the smallest honest answer. When unsure, lean leave-as-is rather than forcing a merge.",
    ],
    { title: "Principles:", style: "bullet" },
  )
  .addBlock(
    "Return the structured verdict. Keep summary/rationale/proposal as plain prose (no code fences, no JSON).",
  )
  .build();

/** Fragmentation-family evaluator agent. Call as `FragmentationEvaluatorAgent({ native: cluster })`. */
export const FragmentationEvaluatorAgent = makeSeedEvaluatorAgent<
  FragmentationCluster,
  z.infer<typeof FragmentationVerdictSchema>
>({
  id: "audit_fragmentation_evaluator_agent",
  systemPrompt: SYSTEM_PROMPT,
  buildInstruction: (cluster) => buildFragmentationInstruction(cluster),
  schema: FragmentationVerdictSchema,
});

// ---------------------------------------------------------------------------
// Family export — registered in AuditAgent
// ---------------------------------------------------------------------------

/** Barrel-hosted clusters are intentional aggregation (re-export), not over-decomposition (§2.3). */
function isBarrelHost(cluster: FragmentationCluster): boolean {
  return /(^|\/)index\.[cm]?[jt]sx?$/.test(cluster.host);
}

export const fragmentationFamily: AuditSeedFamily = {
  kind: "fragmentation",
  label: "Fragmentation",
  async collect() {
    const detection = await detectFragmentationCandidates();
    const kept = detection.clusters.filter((c) => !isBarrelHost(c));
    const preFiltered = detection.clusters.length - kept.length;

    const prepared: PreparedSeed[] = kept.map((cluster) => ({
      seed: fragmentationSeedView(cluster),
      identity: fragmentationIdentity(cluster),
      evaluate: () => FragmentationEvaluatorAgent({ native: cluster }),
    }));

    const stats: AuditFamilyStats = {
      kind: "fragmentation",
      label: "Fragmentation",
      filesScanned: detection.stats.filesScanned,
      filesParsed: detection.stats.filesParsed,
      candidatesFound: detection.clusters.length,
      preFiltered,
    };
    return { prepared, stats };
  },
};
