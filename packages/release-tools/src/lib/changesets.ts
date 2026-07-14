import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function releasedPackagesFromChangesets(repoRoot: string) {
  const packages = new Set<string>();

  for (const file of changesetFiles(repoRoot)) {
    const content = readFileSync(file, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

    if (!frontmatter) {
      continue;
    }

    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(
        /^['"]?([^'":]+\/[^'":]+|@[^'":]+\/[^'":]+|[^'":\s]+)['"]?:\s+(major|minor|patch|none)\s*$/,
      );

      if (match && match[2] !== "none") {
        packages.add(match[1]);
      }
    }
  }

  return packages;
}

function changesetFiles(repoRoot: string) {
  const changesetDir = resolve(repoRoot, ".changeset");

  if (!existsSync(changesetDir)) {
    return [];
  }

  return readdirSync(changesetDir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => resolve(changesetDir, file));
}
