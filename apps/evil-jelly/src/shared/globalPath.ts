import os from "node:os";
import path from "node:path";

/** Global evil-jelly directory: ~/.evil-jelly */
export function resolveGlobalJellyDir(): string {
  return path.join(os.homedir(), ".evil-jelly");
}
