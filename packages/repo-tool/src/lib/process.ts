import { spawnSync } from "node:child_process";

export interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
}

function resolvedCommand(command: string, args: readonly string[]) {
  if (process.platform === "win32" && command === "pnpm") {
    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) {
      throw new Error("repo-tool must be invoked through pnpm on Windows");
    }
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command, args: [...args] };
}

export function capture(command: string, args: readonly string[], cwd: string): RunResult {
  const resolved = resolvedCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

export function run(command: string, args: readonly string[], cwd: string): number {
  const resolved = resolvedCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
