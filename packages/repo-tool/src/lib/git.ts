import { capture } from "./process.js";

export interface Git {
  nul(args: readonly string[]): string[];
  text(args: readonly string[], allowFailure?: boolean): string;
}

export function createGit(repoRoot: string): Git {
  const execute = (args: readonly string[], allowFailure: boolean): string => {
    const result = capture("git", args, repoRoot);
    if (result.status !== 0 && !allowFailure) {
      throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
    }
    return result.status === 0 ? result.stdout : "";
  };

  return {
    nul: (args) =>
      execute([...args, "-z"], false)
        .split("\0")
        .filter(Boolean),
    text: (args, allowFailure = false) => execute(args, allowFailure).trim(),
  };
}

export function resolveBase(git: Git, requested?: string): string {
  const candidates = requested ? [requested] : ["origin/main", "main"];
  for (const candidate of candidates) {
    if (git.text(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], true)) {
      return candidate;
    }
  }
  throw new Error(`Cannot resolve base ref: ${candidates.join(" or ")}`);
}
