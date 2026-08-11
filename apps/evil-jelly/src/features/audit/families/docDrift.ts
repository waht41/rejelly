/**
 * Doc-drift seed family (INV-0015): validate user-facing API docs against the extracted code
 * surface. Phase 1 is deterministic and zero-LLM — split each mapped doc into H1/H2 sections,
 * extract the exported TS surface (and verbatim artifacts) for the doc's mapped paths, and match
 * section mentions against it. Phase 2 judges each section: does it state something the current
 * code contradicts? Intentional simplification is NOT drift (non-actionable verdicts are
 * auto-suppressed by the shared ledger until the section or its surface changes).
 *
 * Ordered top-down like complexity.ts: candidate assembly → seed view → identity → prompt builder →
 * evaluator agent → family export (registered in AuditAgent).
 */

import { z } from "zod";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import { listScriptRelPathsUnder } from "../../../shared/fs-policy/workspace-paths";
import { PromptBuilder } from "../../../shared/lib/promptBuilder";
import type { DocMapEntry, MarkdownSection, MatchableSymbol } from "../detectors/docDrift";
import {
  buildSymbolTable,
  loadDocMap,
  matchSectionSymbols,
  resolveDocMapEntries,
  splitMarkdownH2Sections,
} from "../detectors/docDrift";
import { sha256 } from "../runtime/ledger";
import { makeSeedEvaluatorAgent } from "../seedEvaluator";
import type {
  AuditFamilyStats,
  AuditSeed,
  AuditSeedFamily,
  AuditSeedIdentity,
  PreparedSeed,
} from "../types";
import { AUDIT_DEFAULTS } from "../types";
import type { SurfaceExtraction } from "./surface";
import { extractExportedSurface } from "./surface";

// ---------------------------------------------------------------------------
// Candidate assembly — deterministic Phase 1
// ---------------------------------------------------------------------------

interface DocArtifact {
  file: string;
  text: string;
  hash: string;
}

export interface DocSectionCandidate {
  /** Workspace-relative doc path. */
  docFile: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  lines: number;
  sectionText: string;
  /** Surface symbols this section mentions (signature + JSDoc evidence). */
  matched: MatchableSymbol[];
  /** Mentions with no surface hit (noise-filtered; fenced example code never contributes). */
  unmatched: string[];
  /** Verbatim comparison artifacts from the doc map (schemas, d.ts mirrors). */
  artifacts: DocArtifact[];
  /** Per-doc guidance from the doc map. */
  note?: string;
  /** Hash over the code-side evidence backing this section (ledger invalidation key part). */
  surfaceHash: string;
}

/** Sections that carry no checkable content (bare link lists, one-liners) are pre-filtered. */
function isTrivialSection(section: MarkdownSection, matchedCount: number): boolean {
  if (matchedCount > 0) {
    return false;
  }
  const body = section.text.split(/\r?\n/).slice(1).join("\n").trim();
  return body.length < 40;
}

/** Per-run caches so docs sharing map targets extract each surface/artifact once. */
function createSurfaceCache() {
  const policy = getWorkspaceFsPolicy();
  const surfaces = new Map<string, Promise<SurfaceExtraction>>();
  const artifacts = new Map<string, Promise<DocArtifact | null>>();

  return {
    surfaceFor(paths: string[]): Promise<SurfaceExtraction> {
      const key = [...paths].sort().join("\n");
      const existing = surfaces.get(key);
      if (existing) {
        return existing;
      }
      const created =
        paths.length === 0
          ? Promise.resolve({ symbols: [], filesScanned: 0, filesParsed: 0 })
          : listScriptRelPathsUnder(paths).then((files) => extractExportedSurface(files));
      surfaces.set(key, created);
      return created;
    },
    artifactFor(file: string): Promise<DocArtifact | null> {
      const existing = artifacts.get(file);
      if (existing) {
        return existing;
      }
      const created = policy
        .readFile(file)
        .then((text): DocArtifact | null => ({ file, text, hash: sha256(text) }))
        .catch(() => null);
      artifacts.set(file, created);
      return created;
    },
  };
}

/**
 * Stable digest of one symbol's doc-relevant evidence, for invalidation hashing only. Deliberately
 * excludes file/line: a drift verdict does not depend on where a symbol lives, so file moves and
 * line shifts must not re-trigger evaluation. Prompt display keeps file:line separately
 * ({@link renderMatchedSurface}); instance identity keeps it too (match.ts dedup key).
 */
function symbolEvidence(symbol: MatchableSymbol): string {
  return `${symbol.signature}\n${symbol.jsdoc ?? ""}`;
}

function candidatesForDoc(
  docFile: string,
  markdown: string,
  entry: DocMapEntry,
  surface: SurfaceExtraction,
  artifacts: DocArtifact[],
): { candidates: DocSectionCandidate[]; preFiltered: number } {
  const table = buildSymbolTable(surface.symbols);
  const fullSurfaceHash = sha256(surface.symbols.map(symbolEvidence).join("\n"));
  const artifactHashes = artifacts.map((a) => a.hash);

  const candidates: DocSectionCandidate[] = [];
  let preFiltered = 0;
  for (const section of splitMarkdownH2Sections(markdown)) {
    const { matched, unmatched } = matchSectionSymbols(section, table);
    if (isTrivialSection(section, matched.length)) {
      preFiltered++;
      continue;
    }
    // Matched sections invalidate on their own evidence; narrative sections (no matches) fall back
    // to the full surface hash of the mapped area — coarser, but signatures churn far less than code.
    const surfaceHash = sha256(
      JSON.stringify({
        matched: matched.map(symbolEvidence),
        artifacts: artifactHashes,
        fallback: matched.length === 0 && surface.symbols.length > 0 ? fullSurfaceHash : "",
      }),
    );
    candidates.push({
      docFile,
      headingPath: section.headingPath,
      startLine: section.startLine,
      endLine: section.endLine,
      lines: section.endLine - section.startLine + 1,
      sectionText: section.text,
      matched,
      unmatched,
      artifacts,
      ...(entry.note !== undefined ? { note: entry.note } : {}),
      surfaceHash,
    });
  }
  return { candidates, preFiltered };
}

// ---------------------------------------------------------------------------
// Seed view — family-agnostic view of one candidate
// ---------------------------------------------------------------------------

function docDriftSeedView(candidate: DocSectionCandidate): AuditSeed {
  const heading = candidate.headingPath.join(" › ");
  return {
    kind: "doc-drift",
    id: `doc:${candidate.docFile}#${candidate.startLine}`,
    locations: [
      {
        file: candidate.docFile,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        lines: candidate.lines,
      },
    ],
    fileCount: 1,
    weight: candidate.matched.length * 4 + candidate.unmatched.length,
    label: `${heading} — ${candidate.matched.length} matched symbol(s), ${candidate.unmatched.length} unmatched mention(s)`,
  };
}

// ---------------------------------------------------------------------------
// Identity adapter — stable fingerprint + content hash for the shared ledger
// ---------------------------------------------------------------------------

/**
 * `fingerprint` is keyed by doc file + heading path, so rewording the body keeps the ledger lineage
 * (an accepted/suppressed decision survives edits). `contentHash` covers the section text plus the
 * code-side evidence hash: pure implementation changes that leave signatures/JSDoc/artifacts intact
 * do not re-trigger evaluation (INV-0015 §6 — surface hash is the right invalidation granularity).
 */
export function docDriftIdentityFor(candidate: DocSectionCandidate): AuditSeedIdentity {
  const fingerprint = sha256(
    JSON.stringify({
      kind: "doc-drift",
      docFile: candidate.docFile,
      headingPath: candidate.headingPath,
    }),
  ).slice(0, 24);
  const contentHash = sha256(
    JSON.stringify({
      kind: "doc-drift",
      sectionText: candidate.sectionText,
      surfaceHash: candidate.surfaceHash,
    }),
  );
  return { id: `doc-drift:${fingerprint}`, kind: "doc-drift", fingerprint, contentHash };
}

// ---------------------------------------------------------------------------
// Prompt builder — per-seed evaluator instruction
// ---------------------------------------------------------------------------

function cappedLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return text;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n… (truncated)`;
}

/** Fence with 4 backticks so embedded ``` fences inside docs/artifacts cannot break out. */
function safeFence(lang: string, body: string): string {
  return `\`\`\`\`${lang}\n${body}\n\`\`\`\``;
}

function renderMatchedSurface(candidate: DocSectionCandidate): string | null {
  if (candidate.matched.length === 0) {
    return null;
  }
  const shown = candidate.matched.slice(0, AUDIT_DEFAULTS.maxDocSymbolsPerSection);
  const omitted = candidate.matched.length - shown.length;
  const entries = shown.map((symbol) => {
    const jsdoc = symbol.jsdoc
      ? `${cappedLines(symbol.jsdoc, AUDIT_DEFAULTS.maxDocJsdocLines)}\n`
      : "";
    const signature = cappedLines(symbol.signature, AUDIT_DEFAULTS.maxDocSignatureLines);
    return `// ${symbol.file}:${symbol.line}\n${jsdoc}${signature}`;
  });
  return (
    `Matched code surface (extracted signatures + JSDoc; authoritative for what currently exists):\n` +
    safeFence("ts", entries.join("\n\n")) +
    (omitted > 0 ? `\n(${omitted} more matched symbol(s) omitted — read the files if needed.)` : "")
  );
}

function renderArtifacts(candidate: DocSectionCandidate): string | null {
  if (candidate.artifacts.length === 0) {
    return null;
  }
  const blocks = candidate.artifacts.map(
    (artifact) =>
      `#### ${artifact.file}\n${safeFence("", cappedLines(artifact.text, AUDIT_DEFAULTS.maxDocArtifactLines))}`,
  );
  return `Comparison artifacts from the doc map (verbatim, possibly truncated — read the full file if needed):\n${blocks.join("\n\n")}`;
}

function renderUnmatched(candidate: DocSectionCandidate): string | null {
  if (candidate.unmatched.length === 0) {
    return null;
  }
  const shown = candidate.unmatched.slice(0, AUDIT_DEFAULTS.maxDocUnmatchedMentions);
  const omitted = candidate.unmatched.length - shown.length;
  return (
    `Identifiers this section mentions with no hit in the extracted surface: ` +
    `${shown.map((name) => `\`${name}\``).join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}. ` +
    `Many are properties, parameters, or names from other packages — that alone is not drift. ` +
    `But if the section presents one as a callable API of this surface, verify it with tools; ` +
    `a documented API that no longer exists is the strongest drift signal.`
  );
}

/** Instruction block: the doc section + its code-side evidence, framed as a claim set to verify. */
export function buildDocDriftInstruction(candidate: DocSectionCandidate): string {
  const header =
    `${candidate.docFile}:${candidate.startLine}-${candidate.endLine} — ` +
    candidate.headingPath.join(" › ");

  return new PromptBuilder()
    .addBlock(
      "A deterministic scanner split user-facing API documentation into sections and extracted " +
        "the exported code surface the doc maps to. Judge whether this section makes factual " +
        "claims that the current code contradicts.",
    )
    .addList(
      [
        "Decide isActionable: does the section state something the current code contradicts — a " +
          "wrong signature/parameter/default, a nonexistent API, incorrect behavior, or a stale " +
          "example? Intentional simplification or omission is NOT actionable.",
        "Ground every drift claim in evidence: the shown surface, or files you read with tools. " +
          "Cite file:line in the rationale. Never report drift from memory of how APIs usually look.",
        "If a suspicious claim cannot be verified within budget, report it actionable with " +
          "severity low and state exactly what to check — do not silently pass it.",
        "If actionable, the proposal is the concrete doc fix: what the section should say instead.",
        // Evidence-free sections (no matched surface, no artifacts) would otherwise be told the
        // embedded evidence suffices when there is none — inviting verdicts from memory.
        candidate.matched.length === 0 && candidate.artifacts.length === 0
          ? "No code surface was matched for this section — it is likely narrative/overview " +
            "prose. Only verify claims a user would act on (named APIs, behavior, defaults) " +
            "with read-only tools; if the section makes no checkable factual claims, judge it " +
            "accurate without further tool use."
          : "The embedded evidence is usually enough — use read-only tools sparingly, mainly " +
            "for behavior claims and mentioned-but-unmatched APIs.",
      ],
      { title: "Do:", style: "bullet" },
    )
    .addBlock(
      `### ${header}\n${safeFence("md", cappedLines(candidate.sectionText, AUDIT_DEFAULTS.maxDocSectionLines))}`,
    )
    .addBlock(renderMatchedSurface(candidate))
    .addBlock(renderArtifacts(candidate))
    .addBlock(renderUnmatched(candidate))
    .addBlock(
      candidate.note
        ? `Additional doc-map guidance for this file (does not override the rules above): ${candidate.note}`
        : null,
    )
    .build();
}

// ---------------------------------------------------------------------------
// Evaluator — per-seed agentic precision layer (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Same stored shape as {@link makeVerdictSchema} output (the shared ledger/report requires it), but
 * with doc-drift wording — the generic factory's refactor-flavored descriptions would mislead here.
 */
export const DocDriftVerdictSchema = z.object({
  isActionable: z
    .boolean()
    .describe(
      "True only when the section states something the current code contradicts: wrong " +
        "signature/parameter/default, nonexistent API, incorrect behavior, or a stale example. " +
        "False for intentional simplification, omission, or accurate content.",
    ),
  severity: z
    .enum(["high", "medium", "low"])
    .describe(
      "Fix priority: high = misleads users into broken code (wrong API/signature); medium = real " +
        "but recoverable inaccuracy; low = minor, or a suspicion you could not fully verify. Use " +
        "low when isActionable is false.",
    ),
  category: z
    .enum([
      "signature-drift",
      "default-drift",
      "missing-symbol",
      "behavior-drift",
      "stale-example",
      "simplification",
      "accurate",
    ])
    .describe(
      "Dominant finding type. signature-drift: declared params/types/names differ; default-drift: " +
        "documented default values differ; missing-symbol: a documented API no longer exists; " +
        "behavior-drift: described runtime behavior contradicts the implementation; stale-example: " +
        "example code no longer works as shown; simplification: intentionally simplified but not " +
        "wrong (not actionable); accurate: matches the code (not actionable).",
    ),
  summary: z
    .string()
    .describe("One sentence: which claim is wrong and where (no code, no fences)."),
  rationale: z
    .string()
    .describe(
      "The evidence: what the doc says vs. what the code shows, citing file:line. For " +
        "non-actionable verdicts, why the content is fine (or intentionally simplified).",
    ),
  proposal: z
    .string()
    .describe(
      "Concrete doc fix when actionable: what the section should say instead. Empty string otherwise.",
    ),
});

const SYSTEM_PROMPT = new PromptBuilder()
  .addBlock(
    "You are a technical-documentation auditor. You receive one section of user-facing API docs " +
      "together with the extracted current code surface it maps to. Your job is judgment, not " +
      "rewriting: decide whether the section makes factual claims the code contradicts.",
  )
  .addList(
    [
      "Docs are user-facing: intentional simplification, omission of internals, and pedagogical " +
        "shortcuts are NOT drift. Only report claims a user would act on and be wrong.",
      "Signatures, parameter names, defaults, and enum values in the extracted surface are " +
        "authoritative for what exists today. Prose claims about runtime behavior may require " +
        "reading the implementation with read-only tools before judging.",
      "High precision: every actionable verdict needs concrete evidence (file:line). When content " +
        "is accurate or merely simplified, say so and move on.",
      "Do not punish the doc for describing other packages, CLI flags, or environment variables " +
        "absent from this surface — verify those with tools only when the section's correctness " +
        "hinges on them.",
      "Answer in the same spirit as a release blocker review: would shipping this section mislead " +
        "a user today?",
    ],
    { title: "Principles:", style: "bullet" },
  )
  .addBlock(
    "Return the structured verdict. Keep summary/rationale/proposal as plain prose (no code fences, no JSON).",
  )
  .build();

/** Doc-drift evaluator agent. Call as `DocDriftEvaluatorAgent({ native: candidate })`. */
export const DocDriftEvaluatorAgent = makeSeedEvaluatorAgent<
  DocSectionCandidate,
  z.infer<typeof DocDriftVerdictSchema>
>({
  id: "audit_doc_drift_evaluator_agent",
  systemPrompt: SYSTEM_PROMPT,
  buildInstruction: (candidate) => Promise.resolve(buildDocDriftInstruction(candidate)),
  schema: DocDriftVerdictSchema,
});

// ---------------------------------------------------------------------------
// Family export — registered in AuditAgent
// ---------------------------------------------------------------------------

/** Whether a workspace-relative doc path matches the CLI doc filter (basename or full path). */
function matchesDocFilter(docFile: string, docFilter: string): boolean {
  const normalized = docFilter.replace(/\\/g, "/");
  return docFile === normalized || docFile.split("/").pop() === normalized;
}

async function prepareDoc(
  docFile: string,
  entry: DocMapEntry,
  cache: ReturnType<typeof createSurfaceCache>,
): Promise<
  | { ok: true; markdown: string; surface: SurfaceExtraction; artifacts: DocArtifact[] }
  | { ok: false; warning: string }
> {
  const policy = getWorkspaceFsPolicy();
  let markdown: string;
  try {
    markdown = await policy.readFile(docFile);
  } catch {
    return { ok: false, warning: `Doc map entry points to missing document: ${docFile}` };
  }
  const surface = await cache.surfaceFor(entry.paths ?? []);
  const artifacts = (
    await Promise.all((entry.artifacts ?? []).map((file) => cache.artifactFor(file)))
  ).filter((artifact): artifact is DocArtifact => artifact !== null);
  return { ok: true, markdown, surface, artifacts };
}

export const docDriftFamily: AuditSeedFamily = {
  kind: "doc-drift",
  label: "API doc drift",
  async collect(options) {
    const stats: AuditFamilyStats = {
      kind: "doc-drift",
      label: "API doc drift",
      filesScanned: 0,
      filesParsed: 0,
      candidatesFound: 0,
      preFiltered: 0,
    };
    const docFilter = options?.docFilter;
    const docCodePaths = options?.docCodePaths ?? [];
    const cache = createSurfaceCache();
    const prepared: PreparedSeed[] = [];

    const collectOne = async (docFile: string, entry: DocMapEntry): Promise<void> => {
      if (entry.skip !== undefined) {
        return;
      }
      const data = await prepareDoc(docFile, entry, cache);
      if (!data.ok) {
        stats.warnings = [...(stats.warnings ?? []), data.warning];
        return;
      }
      stats.filesParsed++;

      const { candidates, preFiltered } = candidatesForDoc(
        docFile,
        data.markdown,
        entry,
        data.surface,
        data.artifacts,
      );
      stats.candidatesFound += candidates.length + preFiltered;
      stats.preFiltered += preFiltered;

      for (const candidate of candidates) {
        prepared.push({
          seed: docDriftSeedView(candidate),
          identity: docDriftIdentityFor(candidate),
          evaluate: () => DocDriftEvaluatorAgent({ native: candidate }),
        });
      }
    };

    if (docCodePaths.length > 0 && docFilter !== undefined) {
      const docFile = docFilter.replace(/\\/g, "/");
      stats.filesScanned = 1;
      await collectOne(docFile, { paths: docCodePaths });
      return { prepared, stats, partial: true };
    }

    // Missing map ⇒ zero seeds (audit runs stay unaffected); a malformed map throws loudly.
    const loaded = await loadDocMap();
    if (!loaded) {
      return { prepared: [], stats };
    }

    const allDocEntries = await resolveDocMapEntries(loaded.map);
    const docEntries =
      docFilter !== undefined
        ? allDocEntries.filter(({ docFile }) => matchesDocFilter(docFile, docFilter))
        : allDocEntries;
    stats.filesScanned = docEntries.length;

    for (const { docFile, entry } of docEntries) {
      await collectOne(docFile, entry);
    }

    // A filtered scan must not resolve absent sections in the ledger.
    return { prepared, stats, ...(docFilter !== undefined ? { partial: true } : {}) };
  },
};
