import { spawn } from "node:child_process";
import { BoundedCommandOutput, type CommandCaptureStats } from "./capturedOutput";
import { ShellOutputStreamDecoder } from "./shellOutput";

const DEFAULT_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 3_000;
const POWERSHELL_UTF8_OUTPUT_PREFIX =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
const POWERSHELL_NATIVE_EXIT_CODE_SUFFIX = "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";

interface ShellInvocation {
  readonly file: string;
  readonly args: string[];
  readonly useShell: boolean;
}

function getShellInvocation(command: string): ShellInvocation {
  if (process.platform === "win32") {
    return {
      file: getShellPath(),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `${POWERSHELL_UTF8_OUTPUT_PREFIX}${command}${POWERSHELL_NATIVE_EXIT_CODE_SUFFIX}`,
      ],
      useShell: false,
    };
  }
  return { file: command, args: [], useShell: true };
}

export function getShellPath(): string {
  return process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/sh");
}

function normalizeExitCode(code: number | string | null | undefined): number | null {
  if (typeof code === "number" && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === "string") {
    const parsed = Number.parseInt(code, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export interface ExecuteShellCommandOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ExecuteShellCommandResult {
  exitCode: number | null;
  /** Bounded, decoded output in observed stdout/stderr arrival order, not the model preview. */
  output: string;
  capture: CommandCaptureStats;
  error?: {
    code?: number | string;
    message?: string;
    killed?: boolean;
    signal?: string;
  };
}

async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    return;
  } catch {
    // ignore and fallback to direct pid kill
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore: process may already be gone
  }
}

/**
 * Base shell executor: runs command, captures output, applies timeout, and returns raw outcome.
 */
export async function executeShellCommand(
  options: ExecuteShellCommandOptions,
  onData?: (data: string) => void,
): Promise<ExecuteShellCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const capture = new BoundedCommandOutput();
    const stdoutDecoder = new ShellOutputStreamDecoder();
    const stderrDecoder = new ShellOutputStreamDecoder();
    let outputDecodersFlushed = false;
    let timedOut = false;
    let aborted = false;
    let stopRequested = false;
    let settled = false;
    let forceFinishTimer: NodeJS.Timeout | null = null;

    const invocation = getShellInvocation(options.command);
    const child = spawn(invocation.file, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: invocation.useShell,
      windowsHide: true,
      // Ordinary run_command calls are deliberately non-interactive. Closing
      // stdin makes programs that try to prompt observe EOF instead of hanging
      // on an unwritable pipe until the command timeout.
      stdio: ["ignore", "pipe", "pipe"],
      // On POSIX this gives the shell and its descendants a process group that
      // killProcessTree can terminate without touching Evil Jelly itself.
      detached: process.platform !== "win32",
    });

    const appendDecoded = (data: string) => {
      if (data.length === 0) {
        return;
      }
      capture.append(data);
      onData?.(data);
    };

    const flushOutputDecoders = () => {
      if (outputDecodersFlushed) {
        return;
      }
      outputDecodersFlushed = true;
      appendDecoded(stdoutDecoder.end());
      appendDecoded(stderrDecoder.end());
    };

    function startTermination() {
      if (stopRequested) {
        return;
      }
      stopRequested = true;
      void killProcessTree(child.pid);
      forceFinishTimer = setTimeout(() => {
        finish({
          exitCode: null,
          error: {
            code: timedOut ? "ETIMEDOUT" : "EABORTED",
            message: timedOut ? "Command timed out" : "Command aborted",
            killed: true,
            signal: "SIGTERM",
          },
        });
      }, TERMINATION_GRACE_MS);
    }

    function onAbort() {
      aborted = true;
      startTermination();
    }

    const finish = (result: Omit<ExecuteShellCommandResult, "output" | "capture">) => {
      if (settled) return;
      flushOutputDecoders();
      settled = true;
      clearTimeout(timer);
      if (forceFinishTimer) {
        clearTimeout(forceFinishTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      const captured = capture.snapshot();
      resolve({
        ...result,
        output: captured.text,
        capture: captured.stats,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      startTermination();
    }, timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const appendChunk = (target: "stdout" | "stderr", chunk: Buffer) => {
      const decoder = target === "stdout" ? stdoutDecoder : stderrDecoder;
      if (!settled) appendDecoded(decoder.write(chunk));
    };

    child.stdout?.on("data", (chunk) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendChunk("stderr", chunk));

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        exitCode: normalizeExitCode(err.code),
        error: { code: err.code, message: err.message },
      });
    });

    child.on("close", (code, signal) => {
      if (timedOut || aborted) {
        finish({
          exitCode: normalizeExitCode(code),
          error: {
            code: timedOut ? "ETIMEDOUT" : "EABORTED",
            message: timedOut ? "Command timed out" : "Command aborted",
            killed: true,
            signal: signal ?? "SIGTERM",
          },
        });
        return;
      }

      const normalized = normalizeExitCode(code);
      finish({
        exitCode: normalized,
        ...(normalized === 0
          ? {}
          : {
              error: {
                code: code ?? undefined,
                message:
                  capture.totalBytes > 0
                    ? undefined
                    : `Command failed with exit code ${String(code)}`,
                killed: signal != null,
                signal: signal ?? undefined,
              },
            }),
      });
    });
  });
}
