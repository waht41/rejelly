import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { truncateOutput } from "./output";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_CAPTURE_BYTES = 48_000;
const TERMINATION_GRACE_MS = 3_000;
const WINDOWS_ENCODING_SAMPLE_BYTES = 128;
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

export function getShellEnvironmentSummary(): string {
  return `${process.platform} shell=${getShellPath()}`;
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

class ShellOutputStreamDecoder {
  private readonly utf8Decoder = new StringDecoder("utf8");
  private readonly gb18030Decoder = new TextDecoder("gb18030");
  private mode: "unknown" | "utf8" | "gb18030" = process.platform === "win32" ? "unknown" : "utf8";
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;

  write(chunk: Buffer): string {
    if (this.mode === "utf8") {
      return this.utf8Decoder.write(chunk);
    }
    if (this.mode === "gb18030") {
      return this.gb18030Decoder.decode(chunk, { stream: true });
    }

    if (this.pendingBytes === 0 && chunk.every((byte) => byte < 0x80)) {
      return chunk.toString("utf8");
    }

    this.pendingChunks.push(chunk);
    this.pendingBytes += chunk.length;
    const pending = Buffer.concat(this.pendingChunks, this.pendingBytes);
    const utf8Status = getUtf8Status(pending);
    if (utf8Status === "invalid") {
      return this.flushPendingWithEncoding("gb18030");
    }
    if (this.pendingBytes < WINDOWS_ENCODING_SAMPLE_BYTES || utf8Status === "incomplete") {
      return "";
    }

    return this.flushPendingWithEncoding("utf8");
  }

  end(): string {
    if (this.mode === "unknown") {
      const pending = Buffer.concat(this.pendingChunks, this.pendingBytes);
      return this.flushPendingWithEncoding(getUtf8Status(pending) === "valid" ? "utf8" : "gb18030");
    }
    if (this.mode === "gb18030") {
      return this.gb18030Decoder.decode();
    }
    return this.utf8Decoder.end();
  }

  private flushPendingWithEncoding(mode: "utf8" | "gb18030"): string {
    const pending = Buffer.concat(this.pendingChunks, this.pendingBytes);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.mode = mode;
    if (this.mode === "utf8") {
      return this.utf8Decoder.write(pending);
    }
    return this.gb18030Decoder.decode(pending, { stream: true });
  }
}

type Utf8Status = "valid" | "invalid" | "incomplete";

function getUtf8Status(chunk: Buffer): Utf8Status {
  let i = 0;
  while (i < chunk.length) {
    const first = chunk[i]!;
    if (first <= 0x7f) {
      i += 1;
      continue;
    }

    let needed: number;
    let codePoint: number;
    let minCodePoint: number;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      codePoint = first & 0x1f;
      minCodePoint = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      codePoint = first & 0x0f;
      minCodePoint = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      codePoint = first & 0x07;
      minCodePoint = 0x10000;
    } else {
      return "invalid";
    }

    if (i + needed >= chunk.length) {
      return "incomplete";
    }

    for (let j = 1; j <= needed; j += 1) {
      const continuation = chunk[i + j]!;
      if (continuation < 0x80 || continuation > 0xbf) {
        return "invalid";
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    if (
      codePoint < minCodePoint ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint > 0x10ffff
    ) {
      return "invalid";
    }

    i += needed + 1;
  }
  return "valid";
}

function isValidUtf8(chunk: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(chunk);
    return true;
  } catch {
    return false;
  }
}

function decodeShellOutput(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }
  if (process.platform !== "win32" || isValidUtf8(buffer)) {
    return buffer.toString("utf8");
  }
  return new TextDecoder("gb18030").decode(buffer);
}

export interface ExecuteShellCommandOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxCaptureBytes?: number;
  signal?: AbortSignal;
}

export interface ExecuteShellCommandResult {
  exitCode: number | null;
  output: string;
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
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutDecoder = new ShellOutputStreamDecoder();
    const stderrDecoder = new ShellOutputStreamDecoder();
    let outputDecodersFlushed = false;
    // Captured output goes to the model and is persisted into traces, where
    // ANSI/VT sequences render as garbage; colors only help the live onData
    // stream, which keeps receiving raw chunks.
    const combineCaptured = () => {
      const stdout = decodeShellOutput(Buffer.concat(stdoutChunks, stdoutBytes));
      const stderr = decodeShellOutput(Buffer.concat(stderrChunks, stderrBytes));
      return stripVTControlCharacters([stdout, stderr].filter(Boolean).join("\n"));
    };
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
    });

    const appendDecoded = (data: string) => {
      if (data.length === 0) {
        return;
      }
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
        flushOutputDecoders();
        const combined = combineCaptured();
        if (timedOut) {
          finish({
            exitCode: null,
            output: truncateOutput(combined || "Command timed out", maxCaptureBytes),
            error: {
              code: "ETIMEDOUT",
              message: "Command timed out",
              killed: true,
              signal: "SIGTERM",
            },
          });
          return;
        }
        if (aborted) {
          finish({
            exitCode: null,
            output: truncateOutput(combined || "Command aborted", maxCaptureBytes),
            error: {
              code: "EABORTED",
              message: "Command aborted",
              killed: true,
              signal: "SIGTERM",
            },
          });
        }
      }, TERMINATION_GRACE_MS);
    }

    function onAbort() {
      aborted = true;
      startTermination();
    }

    const finish = (result: ExecuteShellCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceFinishTimer) {
        clearTimeout(forceFinishTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
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
      if (target === "stdout") {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
      appendDecoded(decoder.write(chunk));
    };

    child.stdout?.on("data", (chunk) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendChunk("stderr", chunk));

    child.on("error", (err: NodeJS.ErrnoException) => {
      flushOutputDecoders();
      const combined = combineCaptured() || err.message;
      finish({
        exitCode: normalizeExitCode(err.code),
        output: truncateOutput(combined, maxCaptureBytes),
        error: {
          code: err.code,
          message: err.message,
        },
      });
    });

    child.on("close", (code, signal) => {
      flushOutputDecoders();
      const combined = combineCaptured();

      if (timedOut) {
        finish({
          exitCode: normalizeExitCode(code),
          output: truncateOutput(combined || "Command timed out", maxCaptureBytes),
          error: {
            code: "ETIMEDOUT",
            message: "Command timed out",
            killed: true,
            signal: signal ?? "SIGTERM",
          },
        });
        return;
      }
      if (aborted) {
        finish({
          exitCode: normalizeExitCode(code),
          output: truncateOutput(combined || "Command aborted", maxCaptureBytes),
          error: {
            code: "EABORTED",
            message: "Command aborted",
            killed: true,
            signal: signal ?? "SIGTERM",
          },
        });
        return;
      }

      const normalized = normalizeExitCode(code);
      if (normalized === 0) {
        finish({
          exitCode: 0,
          output: truncateOutput(combined || "(no output)", maxCaptureBytes),
        });
        return;
      }

      finish({
        exitCode: normalized,
        output: truncateOutput(combined, maxCaptureBytes),
        error: {
          code: code ?? undefined,
          message:
            combined.length > 0 ? undefined : `Command failed with exit code ${String(code)}`,
          killed: signal != null,
          signal: signal ?? undefined,
        },
      });
    });
  });
}
