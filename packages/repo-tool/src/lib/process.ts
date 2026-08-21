import { spawn, spawnSync } from "node:child_process";

export interface RunResult {
  cancelled: boolean;
  output: string;
  status: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  output?: "capture" | "inherit" | "tee";
  timeoutMs?: number;
}

const CAPTURE_TAIL_CHARS = 256 * 1_024;

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

function appendTail(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-CAPTURE_TAIL_CHARS);
}

function terminateProcessTree(pid: number | undefined, force = false): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The child may have exited between the timeout/signal and cleanup.
  }
}

export function capture(command: string, args: readonly string[], cwd: string): RunResult {
  const resolved = resolvedCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    cancelled: false,
    output: `${stdout}${stderr}`,
    status: result.status ?? 1,
    stderr,
    stdout,
    timedOut: false,
  };
}

export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const resolved = resolvedCommand(command, args);
  const outputMode = options.output ?? "inherit";
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      stdio:
        outputMode === "inherit" ? ["inherit", "inherit", "inherit"] : ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let output = "";
    let cancelled = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

    const onStdout = (chunk: string) => {
      stdout = appendTail(stdout, chunk);
      output = appendTail(output, chunk);
      if (outputMode === "tee") process.stdout.write(chunk);
    };
    const onStderr = (chunk: string) => {
      stderr = appendTail(stderr, chunk);
      output = appendTail(output, chunk);
      if (outputMode === "tee") process.stderr.write(chunk);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);

    const stop = (reason: "cancelled" | "timeout") => {
      cancelled = reason === "cancelled";
      timedOut = reason === "timeout";
      terminateProcessTree(child.pid);
      if (process.platform !== "win32") {
        forceKillTimeout = setTimeout(() => terminateProcessTree(child.pid, true), 2_000);
        forceKillTimeout.unref();
      }
    };
    const onSigint = () => stop("cancelled");
    const onSigterm = () => stop("cancelled");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    }

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolve({
        cancelled,
        output,
        status: cancelled ? 130 : timedOut ? 124 : (code ?? (signal ? 1 : 0)),
        stderr,
        stdout,
        timedOut,
      });
    });
  });
}
