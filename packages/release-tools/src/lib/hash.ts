import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { exec } from "./exec.js";
import { packageJsonName, toPosixPath } from "./paths.js";

export function normalizedTarballHash(tarball: string) {
  const extractDir = mkdtempSync(join(tmpdir(), "reagent-pack-extract-"));

  try {
    extractTarball(tarball, extractDir);

    const hash = createHash("sha256");
    const files = walkFiles(extractDir)
      .map((file) => ({
        absolute: file,
        relative: toPosixPath(relative(extractDir, file)),
      }))
      .sort((left, right) => left.relative.localeCompare(right.relative));

    for (const file of files) {
      const bytes = normalizedFileBytes(file.absolute, file.relative);
      hash.update(file.relative);
      hash.update("\0");
      hash.update(String(statSync(file.absolute).mode & 0o777));
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }

    return hash.digest("hex");
  } finally {
    rmSync(extractDir, { force: true, recursive: true });
  }
}

export function stableStringify(value: unknown, indent = 0): string {
  const space = "  ".repeat(indent);
  const childSpace = "  ".repeat(indent + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    return `[\n${value.map((item) => `${childSpace}${stableStringify(item, indent + 1)}`).join(",\n")}\n${space}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));

    if (entries.length === 0) {
      return "{}";
    }

    return `{\n${entries
      .map(
        ([key, item]) =>
          `${childSpace}${JSON.stringify(key)}: ${stableStringify(item, indent + 1)}`,
      )
      .join(",\n")}\n${space}}`;
  }

  return JSON.stringify(value);
}

function extractTarball(tarball: string, destination: string) {
  // Feed the archive on stdin (`-f -`) rather than as a path argument. GNU tar
  // reads a path like `C:/foo` (drive letter + colon) as a remote `host:path`;
  // its `--force-local` flag suppresses that, but bsdtar (Windows' bundled tar)
  // rejects the flag. A `-` archive has no colon to misparse, so one invocation
  // works under both. `-C` takes a directory, which is never host:path-parsed.
  exec("tar", ["-xz", "-f", "-", "-C", toPosixPath(destination)], {
    input: readFileSync(tarball),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return walkFiles(path);
    }

    if (entry.isFile()) {
      return [path];
    }

    return [];
  });
}

function normalizedFileBytes(file: string, relativePath: string) {
  const bytes = readFileSync(file);

  if (relativePath === `package/${packageJsonName}`) {
    const json = JSON.parse(bytes.toString("utf8"));
    delete json.version;
    return Buffer.from(`${stableStringify(json)}\n`);
  }

  return bytes;
}
