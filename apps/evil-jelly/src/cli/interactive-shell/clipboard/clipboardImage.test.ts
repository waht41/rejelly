import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupStaleClipboardImages } from "./clipboardImage";

describe("clipboard image orphan cleanup", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("removes only stale owned image files within the bounded application directory", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "evil-clipboard-cleanup-"));
    roots.push(directory);
    const stale = path.join(directory, "clipboard-stale.png");
    const fresh = path.join(directory, "clipboard-fresh.png");
    const unrelated = path.join(directory, "user-image.png");
    await Promise.all([
      fs.writeFile(stale, "stale"),
      fs.writeFile(fresh, "fresh"),
      fs.writeFile(unrelated, "user"),
    ]);
    const now = Date.now();
    await fs.utimes(stale, new Date(now - 10_000), new Date(now - 10_000));

    await expect(cleanupStaleClipboardImages({ directory, now, maxAgeMs: 5_000 })).resolves.toBe(1);
    await expect(fs.access(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(fresh, "utf8")).resolves.toBe("fresh");
    await expect(fs.readFile(unrelated, "utf8")).resolves.toBe("user");
  });
});
