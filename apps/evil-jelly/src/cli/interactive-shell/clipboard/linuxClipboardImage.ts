import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptImageMimeType } from "../../../shared/model/prompt/promptInput";

const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CLIPBOARD_METADATA_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;

const IMAGE_TARGETS: readonly PromptImageMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

const MIME_EXTENSION: Record<PromptImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

type LinuxClipboardBackend = {
  name: string;
  list: { file: string; args: string[] };
  read: (target: string) => { file: string; args: string[] };
};

const LINUX_CLIPBOARD_BACKENDS: readonly LinuxClipboardBackend[] = [
  {
    name: "Wayland wl-paste",
    list: { file: "wl-paste", args: ["--list-types"] },
    read: (target) => ({ file: "wl-paste", args: ["--no-newline", "--type", target] }),
  },
  {
    name: "X11 xclip",
    list: { file: "xclip", args: ["-selection", "clipboard", "-t", "TARGETS", "-o"] },
    read: (target) => ({
      file: "xclip",
      args: ["-selection", "clipboard", "-t", target, "-o"],
    }),
  },
];

export type NativeLinuxClipboardImageResult =
  | { ok: true; path: string; mimeType: PromptImageMimeType }
  | { ok: false; reason: "unsupported" | "empty" | "failed"; message: string };

type CommandRunner = (file: string, args: string[], maxBytes: number) => Promise<Buffer>;

export interface NativeLinuxClipboardImageOptions {
  directory: string;
  runCommand?: CommandRunner;
}

function runCommand(file: string, args: string[], maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "buffer",
        maxBuffer: maxBytes,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function clipboardImagePath(directory: string, mimeType: PromptImageMimeType): string {
  return path.join(
    directory,
    `clipboard-${Date.now()}-${randomUUID()}.${MIME_EXTENSION[mimeType]}`,
  );
}

function commandUnavailable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function commandErrorMessage(error: unknown): string {
  if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `Clipboard image is larger than ${MAX_CLIPBOARD_IMAGE_BYTES / 1024 / 1024} MB.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function detectImageMime(bytes: Buffer): PromptImageMimeType | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const header = bytes.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function advertisedTargets(output: Buffer): Map<string, string> {
  const targets = new Map<string, string>();
  for (const target of output.toString("utf8").split(/\s+/)) {
    if (target) targets.set(target.toLowerCase(), target);
  }
  return targets;
}

function clipboardFilePaths(output: Buffer): string[] {
  const paths: string[] = [];
  for (const rawLine of output.toString("utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line === "copy" || line === "cut") continue;
    if (line.startsWith("file:")) {
      try {
        paths.push(fileURLToPath(line));
      } catch {
        // Ignore malformed or non-local file URLs and continue through the list.
      }
    } else if (path.isAbsolute(line)) {
      paths.push(line);
    }
  }
  return paths;
}

async function copyFirstClipboardImageFile(
  output: Buffer,
  directory: string,
): Promise<NativeLinuxClipboardImageResult | undefined> {
  for (const sourcePath of clipboardFilePaths(output)) {
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_CLIPBOARD_IMAGE_BYTES) {
        return {
          ok: false,
          reason: "failed",
          message: `Clipboard image is larger than ${MAX_CLIPBOARD_IMAGE_BYTES / 1024 / 1024} MB.`,
        };
      }
      const bytes = await fs.readFile(sourcePath);
      const mimeType = detectImageMime(bytes);
      if (!mimeType) continue;
      const destination = clipboardImagePath(directory, mimeType);
      await fs.writeFile(destination, bytes, { flag: "wx" });
      return { ok: true, path: destination, mimeType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { ok: false, reason: "failed", message: commandErrorMessage(error) };
    }
  }
  return undefined;
}

async function readFromBackend(
  backend: LinuxClipboardBackend,
  directory: string,
  runner: CommandRunner,
): Promise<NativeLinuxClipboardImageResult | undefined> {
  const targetOutput = await runner(
    backend.list.file,
    backend.list.args,
    MAX_CLIPBOARD_METADATA_BYTES,
  );
  const targets = advertisedTargets(targetOutput);
  const fileTarget = targets.get("x-special/gnome-copied-files") ?? targets.get("text/uri-list");
  if (fileTarget) {
    const command = backend.read(fileTarget);
    const fileResult = await copyFirstClipboardImageFile(
      await runner(command.file, command.args, MAX_CLIPBOARD_METADATA_BYTES),
      directory,
    );
    if (fileResult) return fileResult;
  }

  for (const mimeType of IMAGE_TARGETS) {
    const advertised = targets.get(mimeType);
    if (!advertised) continue;
    const command = backend.read(advertised);
    const bytes = await runner(command.file, command.args, MAX_CLIPBOARD_IMAGE_BYTES);
    const detectedMime = detectImageMime(bytes);
    if (!detectedMime) continue;
    const destination = clipboardImagePath(directory, detectedMime);
    await fs.writeFile(destination, bytes, { flag: "wx" });
    return { ok: true, path: destination, mimeType: detectedMime };
  }
  return undefined;
}

/** Read a native Wayland/X11 clipboard without introducing a Node native dependency. */
export async function saveNativeLinuxClipboardImage(
  options: NativeLinuxClipboardImageOptions,
): Promise<NativeLinuxClipboardImageResult> {
  const runner = options.runCommand ?? runCommand;
  await fs.mkdir(options.directory, { recursive: true });
  let availableBackend = false;
  const errors: string[] = [];

  for (const backend of LINUX_CLIPBOARD_BACKENDS) {
    try {
      const result = await readFromBackend(backend, options.directory, runner);
      availableBackend = true;
      if (result) return result;
    } catch (error) {
      if (commandUnavailable(error)) continue;
      availableBackend = true;
      errors.push(`${backend.name}: ${commandErrorMessage(error)}`);
    }
  }

  if (!availableBackend) {
    return {
      ok: false,
      reason: "unsupported",
      message: "Clipboard image paste on Linux requires wl-paste (Wayland) or xclip (X11).",
    };
  }
  if (errors.length > 0) {
    return { ok: false, reason: "failed", message: errors.join("; ") };
  }
  return { ok: false, reason: "empty", message: "Clipboard does not contain a supported image." };
}
