#!/usr/bin/env node
// Generates template-*/AGENTS.md from docs/skill.md, rewriting backticked
// `docs/...` references to https://docs.rejelly.dev URLs (cleanUrls: no .md).
// Usage: node script/generate-agents.mjs [--check]
//   --check  verify committed AGENTS.md files are up to date (CI / lint:doc)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const docsDir = path.join(repoRoot, "docs");
const sourcePath = path.join(docsDir, "skill.md");
const packageDir = path.resolve(__dirname, "..");
const targets = ["template-basic", "template-router"].map((template) =>
  path.join(packageDir, template, "AGENTS.md"),
);

const DOCS_BASE = "https://docs.rejelly.dev/";
const checkMode = process.argv.includes("--check");

// Must keep the `<!-- AUTO-GENERATED` prefix: src/index.ts matches it at scaffold
// time (AGENTS_BANNER_PATTERN) to swap in a user-facing banner.
const banner =
  "<!-- AUTO-GENERATED from docs/skill.md by packages/create/script/generate-agents.mjs." +
  " Do not edit by hand; edit docs/skill.md and run `pnpm --filter create-rejelly generate:agents`. -->";

const versionNote = `# Version Note

This file was generated from the Rejelly docs when this version of \`create-rejelly\` was published, so it matches the framework version this project was scaffolded with. The links above point to the latest published documentation. For the exact API surface of the version installed in this project, the type definitions and CHANGELOG in \`node_modules/@rejelly/core\` are authoritative. A machine-readable snapshot of the full docs is available at ${DOCS_BASE}llm.txt.`;

const source = fs.readFileSync(sourcePath, "utf-8").replace(/\r\n/g, "\n");

const errors = [];

// References must be backticked paths ending in ".md" (a page) or "/" (a section
// with an index.md). Anything else fails the build instead of shipping broken links.
const body = source.replace(/`docs\/([^`]+)`/g, (match, docPath) => {
  if (docPath.endsWith(".md")) {
    if (!fs.existsSync(path.join(docsDir, docPath))) {
      errors.push(`dead link ${match}: docs/${docPath} does not exist`);
    }
  } else if (docPath.endsWith("/")) {
    if (!fs.existsSync(path.join(docsDir, docPath, "index.md"))) {
      errors.push(`dead link ${match}: docs/${docPath}index.md does not exist`);
    }
  } else {
    errors.push(`unsupported reference ${match}: must end with ".md" or "/"`);
    return match;
  }
  const url = DOCS_BASE + docPath.replace(/index\.md$/, "").replace(/\.md$/, "");
  return `\`${url}\``;
});

// Catch doc references the pattern above did not recognize, e.g. [text](docs/...) links.
body.split("\n").forEach((line, i) => {
  if (/\bdocs\/zh\//.test(line)) {
    errors.push(`unconverted docs path at docs/skill.md output line ${i + 1}: ${line.trim()}`);
  }
});

if (errors.length > 0) {
  for (const error of errors) console.error(`generate-agents: ${error}`);
  process.exit(1);
}

const output = `${banner}\n\n${body.trimEnd()}\n\n${versionNote}\n`;

let stale = false;
for (const target of targets) {
  const rel = path.relative(repoRoot, target).replaceAll(path.sep, "/");
  if (checkMode) {
    const existing = fs.existsSync(target)
      ? fs.readFileSync(target, "utf-8").replace(/\r\n/g, "\n")
      : null;
    if (existing !== output) {
      console.error(`generate-agents: ${rel} is stale or missing`);
      stale = true;
    }
  } else {
    fs.writeFileSync(target, output);
    console.log(`generate-agents: wrote ${rel}`);
  }
}

if (checkMode) {
  if (stale) {
    console.error(
      "generate-agents: docs/skill.md changed; run `pnpm --filter create-rejelly generate:agents` and commit the result",
    );
    process.exit(1);
  }
  console.log("generate-agents: AGENTS.md files are up to date");
}
