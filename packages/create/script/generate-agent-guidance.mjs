#!/usr/bin/env node
// Generates create-rejelly's committed AGENTS.md and portable Rejelly Skill snapshot.
// Usage: node script/generate-agent-guidance.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const docsDir = path.join(repoRoot, "docs");
const docsEnDir = path.join(docsDir, "en");
const sourcePath = path.join(docsDir, "skill.md");
const packageDir = path.resolve(__dirname, "..");
const skillRoot = path.join(packageDir, "shared", ".agents", "skills", "rejelly");
const referencesRoot = path.join(skillRoot, "references");
const agentTargets = ["template-basic", "template-router"].map((template) =>
  path.join(packageDir, template, "AGENTS.md"),
);

const DOCS_BASE = "https://docs.rejelly.dev/";
const GENERATE_COMMAND = "pnpm --filter create-rejelly generate:guidance";
const checkMode = process.argv.includes("--check");
const excludedReferencePaths = new Set(["index.md", "guide/index.md"]);

function normalizedText(filePath) {
  return fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
}

function posixRelative(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function collectReferenceFiles(directory = docsEnDir) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectReferenceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const relativePath = posixRelative(docsEnDir, fullPath);
      if (!excludedReferencePaths.has(relativePath)) files.push({ fullPath, relativePath });
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

function resolveDocReference(rawPath, errors) {
  const normalized = rawPath.replaceAll("\\", "/");
  if (!normalized.startsWith("docs/en/")) return undefined;
  const relativePath = normalized.slice("docs/en/".length);
  if (relativePath.endsWith(".md")) {
    if (!fs.existsSync(path.join(docsEnDir, relativePath))) {
      errors.push(`dead reference docs/en/${relativePath}`);
    }
    return relativePath;
  }
  if (relativePath.endsWith("/")) {
    const indexPath = `${relativePath}index.md`;
    if (!fs.existsSync(path.join(docsEnDir, indexPath))) {
      errors.push(`dead reference docs/en/${indexPath}`);
    }
    return indexPath;
  }
  errors.push(`unsupported reference docs/en/${relativePath}: must end with ".md" or "/"`);
  return undefined;
}

function rewriteDocReferences(source, mode, errors) {
  return source.replace(/docs\/en\/[^`\s)]+/g, (match) => {
    const relativePath = resolveDocReference(match, errors);
    if (!relativePath) return match;
    if (mode === "skill") return `references/${relativePath}`;
    return `.agents/skills/rejelly/references/${relativePath}`;
  });
}

const source = normalizedText(sourcePath);
const errors = [];
const agentBody = rewriteDocReferences(source, "project", errors);
const skillBody = rewriteDocReferences(source, "skill", errors);

for (const [lineIndex, line] of agentBody.split("\n").entries()) {
  if (/\bdocs\/en\//.test(line)) {
    errors.push(`unconverted docs path at AGENTS.md output line ${lineIndex + 1}: ${line.trim()}`);
  }
}
for (const [lineIndex, line] of skillBody.split("\n").entries()) {
  if (/\bdocs\/en\//.test(line)) {
    errors.push(`unconverted docs path at SKILL.md output line ${lineIndex + 1}: ${line.trim()}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`generate-agent-guidance: ${error}`);
  process.exit(1);
}

// Keep the AUTO-GENERATED prefix: src/index.ts replaces this contributor banner at scaffold time.
const agentBanner =
  "<!-- AUTO-GENERATED from docs/skill.md by packages/create/script/generate-agent-guidance.mjs." +
  ` Do not edit by hand; edit docs/ and run \`${GENERATE_COMMAND}\`. -->`;
const agentVersionNote = `# Version Note

This file and the referenced \`.agents/skills/rejelly/references/\` documentation were generated from the Rejelly docs when this version of \`create-rejelly\` was published. For the exact API surface of the version installed in this project, the type definitions and CHANGELOG in \`node_modules/@rejelly/core\` are authoritative. The latest documentation is available at ${DOCS_BASE}en/, with a machine-readable snapshot at ${DOCS_BASE}llm.txt.`;
const agentOutput = `${agentBanner}\n\n${agentBody.trimEnd()}\n\n${agentVersionNote}\n`;

const skillFrontmatter = `---
name: rejelly
description: Build, modify, test, and troubleshoot TypeScript applications using Rejelly. Use when working with @rejelly/core Agents, equip or expect APIs, prompting, reborn flows, middleware, budgets, testing, or Rejelly adapters.
---`;
const skillBanner =
  "<!-- AUTO-GENERATED from docs/ by packages/create/script/generate-agent-guidance.mjs." +
  ` Do not edit by hand; run \`${GENERATE_COMMAND}\`. -->`;
const skillVersionNote = `# Bundled Documentation

The \`references/\` directory is a versioned snapshot bundled with this release of \`create-rejelly\`. Read only the references relevant to the task. For the installed package's exact API surface, prefer the type definitions and CHANGELOG in \`node_modules/@rejelly/core\`. The latest complete documentation is available at ${DOCS_BASE}llm.txt.`;
const skillOutput = `${skillFrontmatter}\n\n${skillBanner}\n\n${skillBody.trimEnd()}\n\n${skillVersionNote}\n`;

const expectedFiles = new Map([
  ...agentTargets.map((target) => [target, agentOutput]),
  [path.join(skillRoot, "SKILL.md"), skillOutput],
]);
for (const reference of collectReferenceFiles()) {
  expectedFiles.set(
    path.join(referencesRoot, ...reference.relativePath.split("/")),
    normalizedText(reference.fullPath),
  );
}

function collectExistingFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectExistingFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

if (checkMode) {
  let stale = false;
  for (const [target, output] of expectedFiles) {
    if (!fs.existsSync(target) || normalizedText(target) !== output) {
      console.error(
        `generate-agent-guidance: ${posixRelative(repoRoot, target)} is stale or missing`,
      );
      stale = true;
    }
  }
  const expectedSkillFiles = new Set(
    [...expectedFiles.keys()].filter((target) => target.startsWith(`${skillRoot}${path.sep}`)),
  );
  for (const existing of collectExistingFiles(skillRoot)) {
    if (!expectedSkillFiles.has(existing)) {
      console.error(`generate-agent-guidance: ${posixRelative(repoRoot, existing)} is stale`);
      stale = true;
    }
  }
  if (stale) {
    console.error(`generate-agent-guidance: run \`${GENERATE_COMMAND}\` and commit the result`);
    process.exit(1);
  }
  console.log(`generate-agent-guidance: ${expectedFiles.size} generated files are up to date`);
  process.exit(0);
}

fs.rmSync(skillRoot, { recursive: true, force: true });
for (const [target, output] of expectedFiles) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output, "utf-8");
  console.log(`generate-agent-guidance: wrote ${posixRelative(repoRoot, target)}`);
}
