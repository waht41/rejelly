import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveNativeLinuxClipboardImage } from "./linuxClipboardImage";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

describe("native Linux clipboard images", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function tempDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "evil-linux-clipboard-"));
    roots.push(directory);
    return directory;
  }

  it("reads an advertised Wayland image MIME into a composer-owned file", async () => {
    const directory = await tempDirectory();
    const runCommand = vi.fn(async (file: string, args: string[]) => {
      if (file === "wl-paste" && args.includes("--list-types")) {
        return Buffer.from("text/plain\nimage/png\n");
      }
      if (file === "wl-paste" && args.includes("image/png")) return PNG_BYTES;
      throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    });

    const result = await saveNativeLinuxClipboardImage({ directory, runCommand });

    expect(result).toMatchObject({ ok: true, mimeType: "image/png" });
    if (!result.ok) throw new Error(result.message);
    await expect(fs.readFile(result.path)).resolves.toEqual(PNG_BYTES);
  });

  it("prefers a copied image file over raw clipboard image data", async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, "source.png");
    await fs.writeFile(source, PNG_BYTES);
    const runCommand = vi.fn(async (file: string, args: string[]) => {
      if (file === "wl-paste" && args.includes("--list-types")) {
        return Buffer.from("text/uri-list\nimage/jpeg\n");
      }
      if (file === "wl-paste" && args.includes("text/uri-list")) {
        return Buffer.from(`${pathToFileURL(source).href}\n`);
      }
      throw Object.assign(new Error("unexpected command"), { code: "ENOENT" });
    });

    const result = await saveNativeLinuxClipboardImage({ directory, runCommand });

    expect(result).toMatchObject({ ok: true, mimeType: "image/png" });
    if (!result.ok) throw new Error(result.message);
    expect(result.path).not.toBe(source);
    await expect(fs.readFile(result.path)).resolves.toEqual(PNG_BYTES);
    expect(runCommand).not.toHaveBeenCalledWith(
      "wl-paste",
      expect.arrayContaining(["image/jpeg"]),
      expect.anything(),
    );
  });

  it("reports the Linux clipboard packages required when no backend is installed", async () => {
    const directory = await tempDirectory();
    const runCommand = vi.fn(async () => {
      throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    });

    await expect(saveNativeLinuxClipboardImage({ directory, runCommand })).resolves.toEqual({
      ok: false,
      reason: "unsupported",
      message: "Clipboard image paste on Linux requires wl-paste (Wayland) or xclip (X11).",
    });
  });
});
