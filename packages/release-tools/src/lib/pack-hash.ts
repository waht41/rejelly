import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec.js";
import { changedPackagesFromGit } from "./git.js";
import { normalizedTarballHash } from "./hash.js";
import { affectedPackagesFromTurbo } from "./turbo.js";
import type { PublishablePackage } from "./workspace.js";

export type PackHashOptions = {
  all?: boolean;
  base?: string;
  rootImpact?: "all" | "none";
  turboTask?: string;
};

export type PackHashResult =
  | {
      name: string;
      status: "new-version";
      version: string;
    }
  | {
      currentHash: string;
      name: string;
      remoteHash: string;
      status: "changed-same-version" | "unchanged";
      version: string;
    };

type NpmMetadata = {
  versions?: Record<
    string,
    {
      dist: {
        tarball: string;
      };
    }
  >;
};

export function resolvePackHashCandidates(
  repoRoot: string,
  packages: PublishablePackage[],
  options: PackHashOptions,
) {
  if (options.all || !options.base) {
    return {
      packages,
      source: "all",
    };
  }

  const turboCandidates = affectedPackagesFromTurbo(
    repoRoot,
    options.base,
    packages,
    options.turboTask,
  );

  if (turboCandidates) {
    return {
      packages: packages.filter((pkg) => turboCandidates.has(pkg.name)),
      source: "turbo",
    };
  }

  const gitCandidates = changedPackagesFromGit(repoRoot, packages, options).packages;
  return {
    packages: packages.filter((pkg) => gitCandidates.has(pkg.name)),
    source: "git",
  };
}

export async function comparePackage(
  repoRoot: string,
  pkg: PublishablePackage,
  fallbackRegistry: string | undefined,
  tempDir: string,
): Promise<PackHashResult> {
  const registry =
    fallbackRegistry ??
    pkg.registry ??
    process.env.npm_config_registry ??
    "https://registry.npmjs.org/";
  const normalizedRegistry = registry.endsWith("/") ? registry : `${registry}/`;
  const metadata = await fetchJson(packageMetadataUrl(normalizedRegistry, pkg.name));
  const publishedVersion = metadata?.versions?.[pkg.version];

  if (!publishedVersion) {
    return {
      name: pkg.name,
      status: "new-version",
      version: pkg.version,
    };
  }

  const remoteTarball = join(tempDir, `${pkg.name.replace(/[/@]/g, "_")}-remote.tgz`);
  const currentHash = currentPackHash(repoRoot, pkg, tempDir);

  await download(publishedVersion.dist.tarball, remoteTarball);

  const remoteHash = normalizedTarballHash(remoteTarball);

  return {
    currentHash,
    name: pkg.name,
    remoteHash,
    status: currentHash === remoteHash ? "unchanged" : "changed-same-version",
    version: pkg.version,
  };
}

/**
 * Pack the working-tree copy of a package and return its normalized,
 * version-stripped content hash — the same digest `comparePackage` compares
 * against the registry. Lets callers snapshot the current contents even for a
 * package that has no published version to diff against.
 */
export function currentPackHash(
  repoRoot: string,
  pkg: PublishablePackage,
  tempDir: string,
): string {
  return normalizedTarballHash(packCurrentPackage(repoRoot, pkg, tempDir));
}

export async function withTempPackDir<T>(
  callback: (tempDir: string) => T | Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), "reagent-pack-hash-"));

  try {
    return await callback(tempDir);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function packCurrentPackage(repoRoot: string, pkg: PublishablePackage, destination: string) {
  const before = new Set(readdirSync(destination));

  exec("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", destination], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const after = readdirSync(destination).filter(
    (file) => !before.has(file) && file.endsWith(".tgz"),
  );

  if (after.length !== 1) {
    throw new Error(`Expected exactly one packed tarball for ${pkg.name}, found ${after.length}`);
  }

  return join(destination, after[0]);
}

function packageMetadataUrl(registry: string, packageName: string) {
  const encodedName = packageName.startsWith("@")
    ? packageName.replace("/", "%2F")
    : encodeURIComponent(packageName);

  return new URL(encodedName, registry).href;
}

async function fetchJson(url: string): Promise<NpmMetadata | undefined> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.npm.install-v1+json, application/json",
    },
  });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as NpmMetadata;
}

async function download(url: string, destination: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}
