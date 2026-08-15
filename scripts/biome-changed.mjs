import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FORMAT_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".graphql",
  ".gql",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: options.binary ? undefined : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitFiles(root, args) {
  const output = git([...args, "-z"], { cwd: root, binary: true });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function parseArgs(argv) {
  const options = { write: false, allowMany: false, base: undefined, maxFiles: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") {
      options.write = true;
    } else if (argument === "--allow-many") {
      options.allowMany = true;
    } else if (argument === "--base") {
      options.base = argv[++index];
      if (!options.base) throw new Error("--base requires a Git ref");
    } else if (argument === "--max-files") {
      options.maxFiles = Number(argv[++index]);
      if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1) {
        throw new Error("--max-files requires a positive integer");
      }
    } else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: pnpm ${options.write ? "format:changed" : "check:changed"} [options]

Options:
  --write             Apply Biome safe fixes and formatting
  --base <ref>        Compare committed branch changes with this ref (default: origin/main or main)
  --max-files <count> Refuse larger changed-file sets (default: 100)
  --allow-many        Explicitly bypass the changed-file count guard`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function existingBase(root, requested) {
  const candidates = requested ? [requested] : ["origin/main", "main"];
  for (const candidate of candidates) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: root });
      return candidate;
    } catch {
      // Try the next conventional base.
    }
  }
  throw new Error(`Cannot resolve base ref: ${candidates.join(" or ")}`);
}

function collectChangedFiles(root, base) {
  const resolvedRoot = path.resolve(root);
  const mergeBase = git(["merge-base", "HEAD", base], { cwd: root }).trim();
  const candidates = new Set([
    ...gitFiles(root, ["diff", "--name-only", "--diff-filter=ACMRT", mergeBase, "HEAD"]),
    ...gitFiles(root, ["diff", "--name-only", "--diff-filter=ACMRT"]),
    ...gitFiles(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRT"]),
    ...gitFiles(root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...candidates]
    .filter((file) => FORMAT_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .filter((file) => fs.existsSync(path.join(root, file)))
    .map((file) => {
      const absolute = path.resolve(resolvedRoot, file);
      const relative = path.relative(resolvedRoot, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Refusing out-of-workspace path: ${file}`);
      }
      return relative;
    })
    .sort();
}

function runBiome(root, files, write) {
  const args = ["exec", "biome", "check", ...(write ? ["--write"] : []), ...files];
  const npmExecPath = process.env.npm_execpath;
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...args], { cwd: root, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
        cwd: root,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const options = parseArgs(process.argv.slice(2));
const root = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).trim();
const base = existingBase(root, options.base);
const files = collectChangedFiles(root, base);

console.log(
  `Biome ${options.write ? "write" : "check"}: ${files.length} changed file(s), base ${base}`,
);
for (const file of files) console.log(`  ${file}`);

if (files.length === 0) process.exit(0);
if (!options.allowMany && files.length > options.maxFiles) {
  throw new Error(
    `Refusing to process ${files.length} files (limit ${options.maxFiles}); inspect the scope or pass --allow-many`,
  );
}
runBiome(root, files, options.write);
