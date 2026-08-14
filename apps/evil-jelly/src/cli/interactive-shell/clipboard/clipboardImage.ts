import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLIPBOARD_IMAGE_DIRECTORY = path.join(os.tmpdir(), "evil-jelly-clipboard-images");
const CLIPBOARD_IMAGE_NAME_PATTERN = /^clipboard-.*\.png$/;
const DEFAULT_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ORPHAN_SCAN_ENTRIES = 1024;

export type ClipboardImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: "unsupported" | "empty" | "failed"; message: string };

export interface ClipboardImageCleanupOptions {
  directory?: string;
  now?: number;
  maxAgeMs?: number;
  maxEntries?: number;
}

/** Bounded cleanup of stale files from this application's dedicated clipboard-image directory. */
export async function cleanupStaleClipboardImages(
  options: ClipboardImageCleanupOptions = {},
): Promise<number> {
  const directory = options.directory ?? CLIPBOARD_IMAGE_DIRECTORY;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS;
  const maxEntries = options.maxEntries ?? MAX_ORPHAN_SCAN_ENTRIES;
  let removed = 0;
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && CLIPBOARD_IMAGE_NAME_PATTERN.test(candidate.name))
    .slice(0, maxEntries)) {
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath);
    if (now - stat.mtimeMs < maxAgeMs) continue;
    await fs.unlink(filePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    removed += 1;
  }
  return removed;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isTerminalErrorNoise(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x00 && code <= 0x08) ||
    (code >= 0x0b && code <= 0x1f) ||
    code === 0x7f ||
    code === 0xfffd
  );
}

function stripTerminalErrorNoise(text: string): string {
  let stripped = "";
  for (const char of text) {
    if (!isTerminalErrorNoise(char)) {
      stripped += char;
    }
  }
  return stripped;
}

type PlatformCommand = {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
};

// The destination path is passed via an env var (CLIP_IMG_PATH), not as a
// trailing CLI argument: with PowerShell's `-Command`, extra args are NOT bound
// to $args (that only works with `-File`), so it would try to run the path as a
// command and fail with CommandNotFoundException. The macOS branch reads the
// same env var via AppleScript's `system attribute` for symmetry.
function buildWindowsCommand(imagePath: string): PlatformCommand {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
  Write-Output "EMPTY"
  exit 2
}
$image = [System.Windows.Forms.Clipboard]::GetImage()
try {
  $image.Save($env:CLIP_IMG_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "OK"
} finally {
  $image.Dispose()
}
`;
  return {
    file: "powershell.exe",
    args: [
      "-Sta",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    // biome-ignore lint/style/noProcessEnv: platform subprocess must inherit PATH and user env.
    env: { ...process.env, CLIP_IMG_PATH: imagePath },
    windowsHide: true,
  };
}

function buildMacCommand(imagePath: string): PlatformCommand {
  // `the clipboard as «class PNGf»` throws when the clipboard holds no image, so
  // a try/on-error is both the existence check and the read. On empty we print
  // "EMPTY" (exit 0) — unlike PowerShell's `exit 2`, osascript can't easily set a
  // custom exit code, so saveClipboardImage inspects stdout on the success path.
  const script = `
set imgPath to (system attribute "CLIP_IMG_PATH")
try
  set pngData to (the clipboard as «class PNGf»)
on error
  return "EMPTY"
end try
set fh to open for access (POSIX file imgPath) with write permission
try
  set eof fh to 0
  write pngData to fh
  close access fh
on error errMsg
  try
    close access fh
  end try
  error errMsg
end try
return "OK"
`;
  return {
    file: "osascript",
    args: ["-e", script],
    // biome-ignore lint/style/noProcessEnv: platform subprocess must inherit PATH and user env.
    env: { ...process.env, CLIP_IMG_PATH: imagePath },
    windowsHide: false,
  };
}

export async function saveClipboardImage(): Promise<ClipboardImageResult> {
  const dir = CLIPBOARD_IMAGE_DIRECTORY;
  const imagePath = path.join(dir, `clipboard-${timestampSlug()}.png`);

  const command =
    process.platform === "win32"
      ? buildWindowsCommand(imagePath)
      : process.platform === "darwin"
        ? buildMacCommand(imagePath)
        : null;
  if (!command) {
    return {
      ok: false,
      reason: "unsupported",
      message: "Clipboard image paste is only implemented on Windows and macOS.",
    };
  }

  await fs.mkdir(dir, { recursive: true });

  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      windowsHide: command.windowsHide,
      timeout: 10000,
      env: command.env,
    });
    // osascript reports an empty clipboard with a zero exit code, so the success
    // path has to catch it too (PowerShell's `exit 2` lands in the catch below).
    if (stdout?.includes("EMPTY")) {
      return { ok: false, reason: "empty", message: "Clipboard does not contain an image." };
    }
    return { ok: true, path: imagePath };
  } catch (error: unknown) {
    await fs.unlink(imagePath).catch(() => undefined);
    const maybe = error as { code?: number; stderr?: string; stdout?: string; message?: string };
    if (maybe.code === 2 || maybe.stdout?.includes("EMPTY")) {
      return { ok: false, reason: "empty", message: "Clipboard does not contain an image." };
    }
    // stderr can arrive in the console code page (e.g. GBK), which decodes to
    // U+FFFD and control bytes that corrupt terminal rendering — sanitize and
    // collapse it to a single tidy line before surfacing it.
    const raw = maybe.stderr?.trim() || maybe.message || "Failed to read clipboard image.";
    const message = raw.split(/\s+/).join(" ");
    const sanitizedMessage = stripTerminalErrorNoise(message).trim();
    return {
      ok: false,
      reason: "failed",
      message: sanitizedMessage || "Failed to read clipboard image.",
    };
  }
}
