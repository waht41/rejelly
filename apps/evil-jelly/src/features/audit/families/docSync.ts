/**
 * Doc-sync seed family: left/right doc-pair consistency audit. Phase 1 is deterministic
 * and zero-LLM — expand doc-map `sync.pairs` glob rules, union both directions into pairs,
 * and read both sides. Phase 2 judges each pair section by section (ok / inconsistent /
 * left-only / right-only); a pair whose counterpart file is missing gets a
 * deterministic verdict without spending an LLM call. Read-only by design: fixing a drifted pair
 * (translate, merge, decide which side is authoritative) is downstream work driven by the report.
 *
 * This family replaces the retired interactive doc-sync feature (BiSyncDocsAgent): no shadow
 * snapshots, no git-based direction planning, no per-file write approval — just comparison,
 * ledger, report.
 *
 * Ordered top-down like complexity.ts: candidate assembly → seed view → identity → prompt builder →
 * evaluator agent → family export (registered in AuditAgent).
 */

import { z } from "zod";
import { getWorkspaceFiles } from "../../../shared/fs-policy/workspace-files";
import { PromptBuilder } from "../../../shared/model/prompt/builder";
import { loadDocMap, resolveSyncPairs } from "../detectors/docDrift";
import { sha256 } from "../runtime/ledger";
import { makeSeedEvaluatorAgent } from "../seedEvaluator";
import type {
  AuditFamilyStats,
  AuditSeed,
  AuditSeedFamily,
  AuditSeedIdentity,
  PreparedSeed,
  SeedVerdict,
} from "../types";
import { AUDIT_DEFAULTS } from "../types";

// ---------------------------------------------------------------------------
// Candidate assembly — deterministic Phase 1
// ---------------------------------------------------------------------------

export interface DocPairCandidate {
  /** Pair key shown to users: both workspace-relative sides joined. */
  name: string;
  /** Workspace-relative left path (the file may be missing on disk — see leftText). */
  leftFile: string;
  /** Workspace-relative right path (the file may be missing on disk — see rightText). */
  rightFile: string;
  /** null = missing on disk. */
  leftText: string | null;
  /** null = missing on disk. */
  rightText: string | null;
}

function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

// ---------------------------------------------------------------------------
// Seed view — family-agnostic view of one candidate
// ---------------------------------------------------------------------------

function docSyncSeedView(candidate: DocPairCandidate): AuditSeed {
  const sides: Array<{ file: string; text: string }> = [];
  if (candidate.leftText !== null) {
    sides.push({ file: candidate.leftFile, text: candidate.leftText });
  }
  if (candidate.rightText !== null) {
    sides.push({ file: candidate.rightFile, text: candidate.rightText });
  }
  const label =
    candidate.leftText === null
      ? `${candidate.name} — ${candidate.leftFile} missing, ${candidate.rightFile} ${countLines(candidate.rightText ?? "")}L`
      : candidate.rightText === null
        ? `${candidate.name} — ${candidate.leftFile} ${countLines(candidate.leftText)}L, ${candidate.rightFile} missing`
        : `${candidate.name} — ${candidate.leftFile} ${countLines(candidate.leftText)}L / ${candidate.rightFile} ${countLines(candidate.rightText)}L`;

  return {
    kind: "doc-sync",
    id: `pair:${candidate.name}`,
    locations: sides.map(({ file, text }) => {
      const lines = countLines(text);
      return { file, startLine: 1, endLine: Math.max(1, lines), lines };
    }),
    fileCount: sides.length,
    weight: sides.reduce((sum, side) => sum + countLines(side.text), 0),
    label,
  };
}

// ---------------------------------------------------------------------------
// Identity adapter — stable fingerprint + content hash for the shared ledger
// ---------------------------------------------------------------------------

/**
 * `fingerprint` is keyed by both files, so any edit keeps the ledger lineage while multiple target
 * languages sharing a left-side spine do not collide. `contentHash` covers both full bodies: a
 * change on either side re-triggers evaluation. Section alignment is deliberately NOT part of
 * identity — matching translated headings deterministically is the fuzzy machinery this family
 * exists to avoid.
 */
export function docSyncIdentityFor(candidate: DocPairCandidate): AuditSeedIdentity {
  const fingerprint = sha256(
    JSON.stringify({ kind: "doc-sync", left: candidate.leftFile, right: candidate.rightFile }),
  ).slice(0, 24);
  const contentHash = sha256(
    JSON.stringify({
      kind: "doc-sync",
      left: candidate.leftText,
      right: candidate.rightText,
    }),
  );
  return { id: `doc-sync:${fingerprint}`, kind: "doc-sync", fingerprint, contentHash };
}

// ---------------------------------------------------------------------------
// Deterministic verdict — missing counterpart needs no LLM
// ---------------------------------------------------------------------------

/** One side missing is a fact, not a judgment call: verdict is produced without an evaluator run. */
export function missingCounterpartVerdict(candidate: DocPairCandidate): SeedVerdict {
  const missingLeft = candidate.leftText === null;
  const presentFile = missingLeft ? candidate.rightFile : candidate.leftFile;
  const missingFile = missingLeft ? candidate.leftFile : candidate.rightFile;
  const presentLines = countLines((missingLeft ? candidate.rightText : candidate.leftText) ?? "");
  return {
    isActionable: true,
    severity: "high",
    category: "missing-file",
    summary: `${candidate.name}: \`${missingFile}\` is missing while \`${presentFile}\` has ${presentLines} lines.`,
    rationale:
      `\`${presentFile}\` exists but \`${missingFile}\` does not, so the pair cannot be in sync. ` +
      `Detected deterministically; no section comparison was run.`,
    proposal: `Create \`${missingFile}\` by translating \`${presentFile}\` (or delete the orphan if the doc is retired on both sides).`,
  };
}

// ---------------------------------------------------------------------------
// Prompt builder — per-seed evaluator instruction (embeds both sides)
// ---------------------------------------------------------------------------

function cappedLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return text;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n… (truncated — read the file for the rest)`;
}

/** Fence with 4 backticks so embedded ``` fences inside the docs cannot break out. */
function safeFence(lang: string, body: string): string {
  return `\`\`\`\`${lang}\n${body}\n\`\`\`\``;
}

function renderSide(label: string, file: string, text: string): string {
  return (
    `### ${label}: \`${file}\` (${countLines(text)} lines)\n` +
    safeFence("md", cappedLines(text, AUDIT_DEFAULTS.maxDocSyncLinesPerSide))
  );
}

/** Instruction block: both full doc bodies, framed as a section-by-section consistency judgment. */
export function buildDocSyncInstruction(candidate: DocPairCandidate): string {
  return new PromptBuilder()
    .addBlock(
      "A deterministic scanner paired bilingual Markdown files from doc-map sync glob rules. Below are " +
        "the left/right sides of one doc pair. The left side is the walk-through spine. Judge whether " +
        "they still say the same thing, section by section.",
    )
    .addList(
      [
        "Walk the pair in document order using the left side's heading structure as the spine; report every " +
          "section once in `sections`. A section present only on one side gets grade left-only / right-only.",
        "Grade `ok` when the sections convey the same facts. Translation style, idiom, and phrasing " +
          "differences are NOT drift; facts, API names, paths, numbers, option lists, step order, " +
          "tables, and code blocks must agree.",
        "Grade `inconsistent` when one side states something the other contradicts or silently lacks " +
          "(a renamed flag, a removed paragraph, a stale code sample). Name the divergence in `note`.",
        "If a side is truncated above, read the full file with read-only tools before grading its " +
          "tail sections. Do not grade content you have not seen.",
        "isActionable is true only when at least one section is not `ok`. Do not judge which side is " +
          "correct — that is downstream work; your job is to locate the divergence precisely.",
      ],
      { title: "Do:", style: "bullet" },
    )
    .addBlock(renderSide("left", candidate.leftFile, candidate.leftText ?? ""))
    .addBlock(renderSide("right", candidate.rightFile, candidate.rightText ?? ""))
    .build();
}

// ---------------------------------------------------------------------------
// Evaluator — per-seed agentic precision layer (Phase 2)
// ---------------------------------------------------------------------------

const DocSyncSectionSchema = z.object({
  heading: z
    .string()
    .describe(
      "Section heading as written in the left doc (for right-only sections, as written in the right doc).",
    ),
  grade: z
    .enum(["ok", "inconsistent", "left-only", "right-only"])
    .describe(
      "ok: same facts on both sides. inconsistent: the sides contradict or one silently lacks " +
        "content. left-only / right-only: the section exists on that side only.",
    ),
  note: z
    .string()
    .describe("One short sentence naming the concrete divergence; empty string when ok."),
});

export type DocSyncSection = z.infer<typeof DocSyncSectionSchema>;

/**
 * Same stored shape as the shared {@link SeedVerdict} (ledger/report require it) plus the
 * structured per-section grade list, which the family renders into `details` before the verdict is
 * stored — the report and ledger keep one flat shape.
 */
export const DocSyncVerdictSchema = z.object({
  isActionable: z
    .boolean()
    .describe(
      "True only when at least one section is graded inconsistent / left-only / right-only. " +
        "False when every section is ok (the pair is in sync; style differences do not count).",
    ),
  severity: z
    .enum(["high", "medium", "low"])
    .describe(
      "Sync priority: high = the sides contradict on facts a reader would act on, or large parts " +
        "are missing; medium = real but contained divergence; low = minor. Use low when " +
        "isActionable is false.",
    ),
  category: z
    .enum(["content-drift", "structure-drift", "in-sync"])
    .describe(
      "content-drift: matching sections disagree on facts. structure-drift: sections exist on one " +
        "side only or the document shapes diverged. in-sync: no drift (not actionable). Pick the " +
        "dominant one when mixed.",
    ),
  summary: z
    .string()
    .describe("One sentence: which pair drifted and how badly (no code, no fences)."),
  rationale: z
    .string()
    .describe(
      "The evidence: the worst divergences in prose, referencing section headings. For in-sync " +
        "pairs, one sentence confirming the walk-through.",
    ),
  proposal: z
    .string()
    .describe(
      "Concrete sync plan when actionable: which sections to fix on which side. Do not decide " +
        "which side is authoritative when the sides contradict — say the conflict must be resolved " +
        "against the source code. Empty string otherwise.",
    ),
  sections: z
    .array(DocSyncSectionSchema)
    .describe("Per-section grades covering the whole pair in document order."),
});

/** Markdown table for the report `details` block (exported for tests). */
export function renderDocSyncSectionTable(sections: DocSyncSection[]): string {
  if (sections.length === 0) {
    return "";
  }
  const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const rows = sections.map(
    (section) => `| ${cell(section.heading)} | ${section.grade} | ${cell(section.note)} |`,
  );
  return ["**Sections:**", "", "| Section | Grade | Note |", "| --- | --- | --- |", ...rows].join(
    "\n",
  );
}

const SYSTEM_PROMPT = new PromptBuilder()
  .addBlock(
    "You are a bilingual documentation consistency auditor. You receive the left/right sides of one Markdown doc pair " +
      "from doc-map sync glob rules. Your job is judgment, not translation: decide, section by section, " +
      "whether the two sides still convey the same content.",
  )
  .addList(
    [
      "You compare content, you do not fix it. Never propose wording; locate divergences so a " +
        "downstream agent (with access to the source code) can resolve them.",
      "Translation freedom is expected: different sentence structure, idioms, or paragraph " +
        "granularity with the same facts is `ok`.",
      "Facts are strict: API names, flags, paths, defaults, numbers, tables, code blocks, and the " +
        "set of documented behaviors must match. A fact present on one side and absent on the " +
        "other is drift, not style.",
      "Cross-doc links follow a locale-mirroring convention: each side is expected to link to its " +
        "own language's variant of the target doc (left links the left-language variant where " +
        "right links the matching right-language variant). Links that point at the same target " +
        "and differ only by language variant are `ok`; a side linking to the counterpart " +
        "language's variant, or the sides pointing at genuinely different targets, is drift.",
      "Report every section exactly once — the section list is the main artifact; the prose " +
        "fields summarize it.",
      "High precision: when unsure whether a difference is style or drift, grade ok and keep the " +
        "doubt out of the report — downstream re-checks are expensive.",
    ],
    { title: "Principles:", style: "bullet" },
  )
  .addBlock(
    "Return the structured verdict. Keep summary/rationale/proposal as plain prose (no code fences, no JSON).",
  )
  .build();

/** Doc-sync evaluator agent. Call as `DocSyncEvaluatorAgent({ native: candidate })`. */
export const DocSyncEvaluatorAgent = makeSeedEvaluatorAgent<
  DocPairCandidate,
  z.infer<typeof DocSyncVerdictSchema>
>({
  id: "audit_doc_sync_evaluator_agent",
  systemPrompt: SYSTEM_PROMPT,
  buildInstruction: (candidate) => Promise.resolve(buildDocSyncInstruction(candidate)),
  schema: DocSyncVerdictSchema,
});

/** Run the evaluator and flatten its section list into the stored verdict shape. */
async function evaluatePair(candidate: DocPairCandidate): Promise<SeedVerdict> {
  const { sections, ...verdict } = await DocSyncEvaluatorAgent({ native: candidate });
  return { ...verdict, details: renderDocSyncSectionTable(sections) };
}

// ---------------------------------------------------------------------------
// Family export — registered in AuditAgent
// ---------------------------------------------------------------------------

export const docSyncFamily: AuditSeedFamily = {
  kind: "doc-sync",
  label: "Bilingual doc sync",
  async collect() {
    const policy = getWorkspaceFiles();
    const loaded = await loadDocMap();
    const warnings: string[] = [];
    const pairs =
      loaded === null
        ? []
        : await resolveSyncPairs(loaded.map, (warning) => warnings.push(warning));

    const prepared: PreparedSeed[] = [];
    for (const { leftFile, rightFile } of pairs) {
      const [leftText, rightText] = await Promise.all([
        policy.readFile(leftFile).catch((): null => null),
        policy.readFile(rightFile).catch((): null => null),
      ]);
      if (leftText === null && rightText === null) {
        continue;
      }
      const candidate: DocPairCandidate = {
        name: `${leftFile} ⇄ ${rightFile}`,
        leftFile,
        rightFile,
        leftText,
        rightText,
      };
      prepared.push({
        seed: docSyncSeedView(candidate),
        identity: docSyncIdentityFor(candidate),
        evaluate:
          leftText === null || rightText === null
            ? () => Promise.resolve(missingCounterpartVerdict(candidate))
            : () => evaluatePair(candidate),
      });
    }

    const stats: AuditFamilyStats = {
      kind: "doc-sync",
      label: "Bilingual doc sync",
      filesScanned: prepared.reduce((sum, seed) => sum + seed.seed.fileCount, 0),
      filesParsed: prepared.length,
      candidatesFound: prepared.length,
      preFiltered: 0,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return { prepared, stats };
  },
};
