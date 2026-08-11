/**
 * Complexity seed family: function-complexity detection (Phase 1) + the complexity identity adapter +
 * the complexity evaluator, wired into the generic audit driver. Unlike clone there is no declaration
 * pre-filter — the detector's metric thresholds already gate trivia — so every candidate goes to the
 * precision layer (which still rejects essential/intentional size).
 *
 * Ordered top-down: seed view → identity adapter (ledger fingerprint) → prompt builder →
 * evaluator agent (Phase 2, agentic precision layer) → family export (registered in AuditAgent).
 */

import type { z } from "zod";
import { PromptBuilder } from "../../../shared/model/prompt/builder";
import type { ComplexityFinding } from "../detectors/complexity";
import { detectComplexityCandidates } from "../detectors/complexity";
import {
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

// ---------------------------------------------------------------------------
// Seed view — family-agnostic view of one detector candidate
// ---------------------------------------------------------------------------

function complexitySeedView(finding: ComplexityFinding): AuditSeed {
  return {
    kind: "complexity",
    id: finding.id,
    locations: [
      {
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        lines: finding.metrics.lines,
      },
    ],
    fileCount: 1,
    weight: finding.score,
    label:
      `${finding.name} — ${finding.metrics.lines} lines, depth ${finding.metrics.maxDepth}, ` +
      `cc ${finding.metrics.branches}, ${finding.metrics.params} param(s)`,
  };
}

// ---------------------------------------------------------------------------
// Identity adapter — stable fingerprint + content hash for the shared ledger
// ---------------------------------------------------------------------------

/**
 * `fingerprint` stays stable for the *same function* across edits: for named functions it is keyed by
 * file + name, so renaming inner variables or growing the body keeps the ledger lineage (an accepted /
 * suppressed decision survives). Anonymous functions fall back to their normalized token shape to
 * disambiguate. `contentHash` uses the raw current slice, so any real change re-triggers evaluation.
 */

export interface ComplexityIdentityResolver {
  identityFor(finding: ComplexityFinding): Promise<AuditSeedIdentity>;
}

/** Create a per-run resolver so repeated findings in one file do not re-read or re-parse it. */
export function createComplexityIdentityResolver(): ComplexityIdentityResolver {
  const snapshotFor = createAuditSourceSnapshotReader();

  return {
    async identityFor(finding) {
      const snapshot = await snapshotFor(finding.file);
      const range = { startLine: finding.startLine, endLine: finding.endLine };
      const raw = sliceAuditSourceLines(snapshot.lines, range);
      const normalized =
        snapshot.tokens && snapshot.tokens.length > 0
          ? tokensInLineRange(snapshot.tokens, range)
          : normalizeAuditSourceFallback(raw);
      const anonymous = finding.name === "(anonymous)";

      const fingerprint = sha256(
        JSON.stringify({
          kind: "complexity",
          file: finding.file,
          name: finding.name,
          // Named functions stay identity-stable across body edits; anonymous ones need a shape key.
          shape: anonymous ? sha256(normalized || normalizeAuditSourceFallback(raw)) : "",
        }),
      ).slice(0, 24);
      const contentHash = sha256(
        JSON.stringify({ kind: "complexity", file: finding.file, slice: sha256(raw) }),
      );

      return {
        id: `complexity:${fingerprint}`,
        kind: "complexity",
        fingerprint,
        contentHash,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builder — per-seed evaluator instruction (embeds the candidate's source)
// ---------------------------------------------------------------------------

/** Instruction block: the function's source + measured metrics, framed as a candidate to judge. */
export async function buildComplexityInstruction(finding: ComplexityFinding): Promise<string> {
  const slice = await readCappedLineSlice(
    finding.file,
    finding,
    AUDIT_DEFAULTS.maxComplexityBodyLines,
  );
  const { metrics } = finding;
  const header = `${finding.file}:${finding.startLine}-${finding.endLine} — ${finding.name}`;
  const body = slice === null ? "(could not read source)" : fencedCodeBlock(finding.file, slice);

  return new PromptBuilder()
    .addBlock(
      `A deterministic complexity detector flagged the function \`${finding.name}\` in ` +
        `\`${finding.file}\` (lines ${finding.startLine}-${finding.endLine}) as hard to read. ` +
        `Measured: ${metrics.lines} lines, max nesting depth ${metrics.maxDepth}, ` +
        `cyclomatic ≈ ${metrics.branches}, ${metrics.params} parameter(s). ` +
        `Threshold(s) crossed: ${finding.reasons.join("; ")}.`,
    )
    .addBlock(`### ${header}\n${body}`)
    .addList(
      [
        "Decide isActionable: is this genuinely worth decomposing, or is the size/branching essential " +
          "(e.g. a flat exhaustive switch, a config table, generated code) and clearer left whole?",
        "If actionable, give a concrete plan: which cohesive blocks to extract into named helpers, where " +
          "they belong (respect the layering cascade), and how the function reads afterward.",
        "Pick the category that fits: extract-helpers (pull out sub-steps), early-return (flatten nesting), " +
          "split-module (the function is doing several jobs), simplify-conditional, data-driven (replace " +
          "branching with a table), or leave-as-is.",
        "You may use read-only tools for callers/context, but the body above is usually enough — stay cheap.",
      ],
      { title: "Do:", style: "bullet" },
    )
    .build();
}

// ---------------------------------------------------------------------------
// Evaluator — per-seed agentic precision layer (Phase 2)
// ---------------------------------------------------------------------------

export const ComplexityVerdictSchema = makeVerdictSchema({
  actionableDescribe:
    "True only if this function is genuinely worth decomposing for readability/maintainability. " +
    "False when the size/branching is essential and clearer left whole — a flat exhaustive switch, " +
    "a config/lookup table, generated code, or a single cohesive algorithm that does not split cleanly.",
  categories: [
    "extract-helpers",
    "early-return",
    "split-module",
    "simplify-conditional",
    "data-driven",
    "leave-as-is",
  ],
  categoryDescribe:
    "The decomposition shape that best resolves this; leave-as-is when the complexity is essential.",
});

const SYSTEM_PROMPT = new PromptBuilder()
  .addBlock(
    "You are a senior code reviewer focused on function complexity. You receive one function a " +
      "deterministic detector flagged as large / deeply nested / over-branched. Your job is judgment, " +
      "not detection: decide whether decomposing it genuinely improves the code, and if so design the split.",
  )
  .addList(
    [
      "Big is not automatically bad. Reject candidates whose size is essential: flat exhaustive " +
        "switches, config/lookup tables, generated code, or one cohesive algorithm that would only get " +
        "harder to follow if scattered.",
      "Actionable = the function mixes several responsibilities or hides cohesive sub-steps behind deep " +
        "nesting, so a reader cannot hold it in their head and changes are risky.",
      "Be concrete and grounded in the shown code. Name the actual blocks to extract; do not invent helpers " +
        "or files you have not seen.",
      "Proposals must respect the layering cascade (cli → shell → feature → tools → service → shared): " +
        "extracted helpers belong at or below the caller's layer.",
      "Prefer the smallest honest answer. When unsure, lean leave-as-is rather than over-fragmenting.",
    ],
    { title: "Principles:", style: "bullet" },
  )
  .addBlock(
    "Return the structured verdict. Keep summary/rationale/proposal as plain prose (no code fences, no JSON).",
  )
  .build();

/** Complexity-family evaluator agent. Call as `ComplexityEvaluatorAgent({ native: finding })`. */
export const ComplexityEvaluatorAgent = makeSeedEvaluatorAgent<
  ComplexityFinding,
  z.infer<typeof ComplexityVerdictSchema>
>({
  id: "audit_complexity_evaluator_agent",
  systemPrompt: SYSTEM_PROMPT,
  buildInstruction: (finding) => buildComplexityInstruction(finding),
  schema: ComplexityVerdictSchema,
});

// ---------------------------------------------------------------------------
// Family export — registered in AuditAgent
// ---------------------------------------------------------------------------

export const complexityFamily: AuditSeedFamily = {
  kind: "complexity",
  label: "Function complexity",
  async collect() {
    const detection = await detectComplexityCandidates();
    const resolver = createComplexityIdentityResolver();
    const prepared: PreparedSeed[] = await Promise.all(
      detection.findings.map(async (finding) => ({
        seed: complexitySeedView(finding),
        identity: await resolver.identityFor(finding),
        evaluate: () => ComplexityEvaluatorAgent({ native: finding }),
      })),
    );

    const stats: AuditFamilyStats = {
      kind: "complexity",
      label: "Function complexity",
      filesScanned: detection.stats.filesScanned,
      filesParsed: detection.stats.filesParsed,
      candidatesFound: detection.stats.findingsBeforeCap,
      preFiltered: 0,
    };
    return { prepared, stats };
  },
};
