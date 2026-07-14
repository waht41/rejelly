import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This script lives in notes/script/. notesRoot is the notes/ workspace it lints;
// repoRoot is only used to render nice "notes/..." relative paths in messages.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const notesRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(notesRoot, "..");

const specs = [
  {
    name: "issue",
    dir: path.join(notesRoot, "issues"),
    filePattern: /^(ISSUE-\d{4})(?:-.+)?\.md$/,
    required: ["title", "severity", "status", "createdAt", "updatedAt"],
    enums: {
      severity: ["critical", "high", "medium", "low"],
      status: ["open", "in-progress", "later", "done", "wontfix"],
    },
    forbidden: ["id"],
  },
  {
    name: "investigation",
    dir: path.join(notesRoot, "investigations"),
    filePattern: /^INV-\d{4}-.+\.md$/,
    required: ["title", "status", "createdAt", "updatedAt", "type"],
    enums: {
      status: ["active", "later", "resolved", "superseded", "archived"],
      type: ["investigation"],
    },
  },
  {
    name: "decision",
    dir: path.join(notesRoot, "decisions"),
    filePattern: /^DR-\d{4}-.+\.md$/,
    required: ["title", "status", "createdAt", "decidedAt", "type"],
    enums: {
      status: ["proposed", "accepted", "superseded"],
      type: ["decision"],
    },
  },
];

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  const errors = [];

  for (const spec of specs) {
    const files = await markdownFiles(spec.dir);
    for (const fileName of files) {
      const filePath = path.join(spec.dir, fileName);
      const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, "/");

      if (!spec.filePattern.test(fileName)) {
        errors.push(`${relativePath}: invalid ${spec.name} filename`);
      }

      const raw = (await readFile(filePath, "utf8")).replace(/\r\n/g, "\n");
      const metadata = parseFrontmatter(raw, relativePath, errors);
      if (!metadata) continue;

      for (const key of spec.required) {
        if (!(key in metadata)) {
          errors.push(`${relativePath}: missing required frontmatter field "${key}"`);
        }
      }

      for (const key of spec.forbidden ?? []) {
        if (key in metadata) {
          errors.push(`${relativePath}: forbidden frontmatter field "${key}"`);
        }
      }

      for (const [key, values] of Object.entries(spec.enums)) {
        const value = metadata[key];
        if (value !== undefined && !values.includes(String(value))) {
          errors.push(`${relativePath}: invalid ${key} "${value}", expected ${values.join(" | ")}`);
        }
      }

      for (const key of ["createdAt", "updatedAt", "decidedAt", "closedAt"]) {
        const value = metadata[key];
        if (value !== undefined && !datePattern.test(String(value))) {
          errors.push(`${relativePath}: invalid ${key} "${value}", expected YYYY-MM-DD`);
        }
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  console.log("lint-docs: ok");
}

async function markdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));
}

function parseFrontmatter(raw, filePath, errors) {
  if (!raw.startsWith("---\n")) {
    errors.push(`${filePath}: missing frontmatter`);
    return undefined;
  }

  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    errors.push(`${filePath}: unterminated frontmatter`);
    return undefined;
  }

  const lines = raw.slice(4, end).split("\n");
  const metadata = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const blockMatch = /^([A-Za-z][\w-]*):\s*$/.exec(line);
    if (blockMatch) {
      metadata[blockMatch[1]] = [];
      index += 1;
      while (index < lines.length && /^\s+/.test(lines[index])) index += 1;
      continue;
    }

    const scalarMatch = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!scalarMatch) {
      errors.push(`${filePath}: invalid frontmatter line "${line}"`);
      index += 1;
      continue;
    }

    metadata[scalarMatch[1]] = stripQuotes(scalarMatch[2].trim());
    index += 1;
  }

  return metadata;
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
