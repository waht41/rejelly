import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloneCluster } from "../../../services/clone";
import {
  getWorkspaceFsPolicy,
  setWorkspaceRoot,
} from "../../../shared/fs-policy/workspace-fs-policy";
import { createCloneIdentityResolver } from "./clone";

let previousRoot = "";

function cluster(startLine: number, endLine: number): CloneCluster {
  return {
    id: `lines-${startLine}-${endLine}`,
    fragments: [
      { file: "src/a.ts", startLine, endLine, lines: endLine - startLine + 1 },
      { file: "src/b.ts", startLine, endLine, lines: endLine - startLine + 1 },
    ],
    fileCount: 2,
    maxLines: endLine - startLine + 1,
    sharedFingerprints: 8,
  };
}

const A = `export function totalOrders(orders) {
  let total = 0;
  for (const order of orders) {
    total += order.amount;
  }
  return total;
}
`;

const B = `export function totalSales(records) {
  let sum = 0;
  for (const record of records) {
    sum += record.value;
  }
  return sum;
}
`;

describe("createCloneIdentityResolver", () => {
  beforeEach(async () => {
    previousRoot = getWorkspaceFsPolicy().getRoot();
    const dir = await mkdtemp(path.join(os.tmpdir(), "evil-audit-ledger-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    setWorkspaceRoot(dir);
  });

  afterEach(() => {
    setWorkspaceRoot(previousRoot);
  });

  it("keeps the clone fingerprint stable across line moves but changes contentHash on raw edits", async () => {
    await writeFile(path.join(getWorkspaceFsPolicy().getRoot(), "src", "a.ts"), A, "utf-8");
    await writeFile(path.join(getWorkspaceFsPolicy().getRoot(), "src", "b.ts"), B, "utf-8");
    const first = await createCloneIdentityResolver().identityFor(cluster(1, 7));

    await writeFile(
      path.join(getWorkspaceFsPolicy().getRoot(), "src", "a.ts"),
      `\n\n${A}`,
      "utf-8",
    );
    await writeFile(
      path.join(getWorkspaceFsPolicy().getRoot(), "src", "b.ts"),
      `\n\n${B}`,
      "utf-8",
    );
    const moved = await createCloneIdentityResolver().identityFor(cluster(3, 9));

    await writeFile(
      path.join(getWorkspaceFsPolicy().getRoot(), "src", "b.ts"),
      `\n\n${B.replace("record.value", "record.netValue")}`,
      "utf-8",
    );
    const rawEdited = await createCloneIdentityResolver().identityFor(cluster(3, 9));

    expect(moved.fingerprint).toBe(first.fingerprint);
    expect(rawEdited.fingerprint).toBe(first.fingerprint);
    expect(rawEdited.contentHash).not.toBe(moved.contentHash);
  });
});
