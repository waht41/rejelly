import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import type { FsOutsideAccessPayload } from "../../../shared/host/toolConfirmationBindings";
import { createTestHostBindings } from "../__tests__/testHostBindings";
import {
  astDocumentSymbolsService,
  astModuleExportsService,
  astReadSymbolCodeService,
  astWorkspaceSymbolsService,
} from "./document-symbol";

const hostBindingMock = vi.hoisted(() => ({
  current: null as EvilJellyBindings | null,
}));

vi.mock("../../../shared/host/context", () => ({
  getBinding: () => {
    if (!hostBindingMock.current) {
      throw new Error("No test host binding registered.");
    }
    return hostBindingMock.current;
  },
}));

describe("heuristic AST document symbol extensions", () => {
  let prevRoot: string;
  let tmpDir: string;
  const relFile = "packages/core/src/budget-system.ts";

  beforeEach(async () => {
    prevRoot = getWorkspaceRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-doc-symbol-"));
    await fs.mkdir(path.join(tmpDir, "packages", "core", "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, relFile),
      [
        "function _parseAndValidate(input: string): boolean {",
        "  return input.length > 0",
        "}",
        "",
        "/**",
        " * Equip the budget system for runtime checks.",
        " */",
        "export function equipSystem(amount: number): string {",
        "  return String(amount)",
        "}",
        "",
        "export const itemMergeKey = (id: string): string => id // Merge by item id",
      ].join("\n"),
      "utf-8",
    );
    setWorkspaceRoot(tmpDir);
  });

  afterEach(async () => {
    hostBindingMock.current = null;
    setWorkspaceRoot(prevRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("ast_document_symbols includes signature and description details", async () => {
    const raw = await astDocumentSymbolsService({ filePath: relFile });
    const parsed = JSON.parse(raw) as {
      symbols: Array<{
        name: string;
        exported?: boolean;
        signature?: string | null;
        description?: string | null;
        inlineComment?: string;
      }>;
    };
    const equip = parsed.symbols.find((s) => s.name === "equipSystem");
    const mergeKey = parsed.symbols.find((s) => s.name === "itemMergeKey");
    expect(parsed.symbols[0]?.name).toBe("equipSystem");
    expect(parsed.symbols[1]?.name).toBe("itemMergeKey");
    expect(equip?.exported).toBe(true);
    expect(equip?.signature).toContain("equipSystem(amount: number): string");
    expect(equip?.description).toContain("Equip the budget system");
    expect(mergeKey?.signature).toContain("itemMergeKey");
    expect(mergeKey?.inlineComment).toContain("Merge by item id");
  });

  it("ast_read_symbol_code returns declaration source blocks", async () => {
    const raw = await astReadSymbolCodeService({
      filePath: relFile,
      symbolName: "equipSystem",
      caseInsensitive: false,
    });
    const parsed = JSON.parse(raw) as {
      results: Array<{
        symbolName: string;
        matches: Array<{ code: string; signature: string | null; jsDoc: string | null }>;
      }>;
    };
    const hit = parsed.results[0]?.matches[0];
    expect(hit?.code).toContain("export function equipSystem");
    expect(hit?.signature).toContain("equipSystem(amount: number): string");
    expect(hit?.jsDoc).toContain("Equip the budget system");
  });

  it("confirms and parses one outside source file", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-outside-ast-"));
    const outsideFile = path.join(outsideDir, "external.ts");
    await fs.writeFile(outsideFile, "export function outsideSymbol() { return true }\n", "utf8");
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "normal", outsideAccessRequests });

    try {
      const raw = await astDocumentSymbolsService({ filePath: outsideFile });
      const parsed = JSON.parse(raw) as { file: string; symbols: Array<{ name: string }> };

      expect(outsideAccessRequests).toHaveLength(1);
      expect(parsed.file).toBe(outsideFile.replace(/\\/g, "/"));
      expect(parsed.symbols.map((symbol) => symbol.name)).toContain("outsideSymbol");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("scans an approved outside root for workspace symbols", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-outside-ast-root-"));
    await fs.writeFile(
      path.join(outsideDir, "external.ts"),
      "export const outsideRootSymbol = true\n",
      "utf8",
    );
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "normal", outsideAccessRequests });

    try {
      const raw = await astWorkspaceSymbolsService({
        queryName: "outsideRootSymbol",
        caseInsensitive: false,
        roots: [outsideDir],
      });
      const parsed = JSON.parse(raw) as { matches: Array<{ file: string; name: string }> };

      expect(outsideAccessRequests).toHaveLength(1);
      expect(outsideAccessRequests[0]?.access).toBe("scan");
      expect(parsed.matches).toEqual([
        expect.objectContaining({
          file: path.join(outsideDir, "external.ts").replace(/\\/g, "/"),
          name: "outsideRootSymbol",
        }),
      ]);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("ast_module_exports returns export-only topology", async () => {
    const raw = await astModuleExportsService({ filePath: relFile });
    const parsed = JSON.parse(raw) as {
      exports: Array<{ name: string }>;
      totalExports: number;
    };
    const names = parsed.exports.map((s) => s.name);
    expect(names).toContain("equipSystem");
    expect(names).toContain("itemMergeKey");
    expect(names).not.toContain("_parseAndValidate");
    expect(parsed.totalExports).toBe(2);
  });

  it("ast_module_exports captures re-export barrel entries", async () => {
    const barrel = "packages/core/src/index.ts";
    await fs.writeFile(
      path.join(tmpDir, barrel),
      [
        "export type { BudgetConfig, BudgetState } from './core/context/budget'",
        "export { createAgent } from './core/engine/agent'",
        "export * from './core/primitives/run'",
      ].join("\n"),
      "utf-8",
    );

    const raw = await astModuleExportsService({ filePath: barrel });
    const parsed = JSON.parse(raw) as {
      exports: Array<{
        kind: string;
        name: string;
        source?: string | null;
        isTypeOnly?: boolean;
      }>;
      totalExports: number;
    };
    expect(parsed.totalExports).toBe(4);
    expect(parsed.exports.some((e) => e.kind === "re-export" && e.name === "BudgetConfig")).toBe(
      true,
    );
    expect(parsed.exports.some((e) => e.kind === "re-export" && e.name === "createAgent")).toBe(
      true,
    );
    expect(parsed.exports.some((e) => e.kind === "re-export-all" && e.name === "*")).toBe(true);
  });

  it("ast_workspace_symbols scans workspaces containing plain .js files without crashing", async () => {
    // Regression: TS-only rule kinds (interface_declaration, ...) used to throw
    // "Kind `interface_declaration` is invalid" as soon as the scan hit a JS parse.
    const jsFile = "scripts/build-helper.js";
    await fs.mkdir(path.join(tmpDir, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, jsFile),
      ["export function equipSystem(amount) {", "  return String(amount)", "}"].join("\n"),
      "utf-8",
    );

    const raw = await astWorkspaceSymbolsService({
      queryName: "equipSystem",
      caseInsensitive: false,
    });
    const parsed = JSON.parse(raw) as {
      matches: Array<{ file: string; name: string; kind: string }>;
    };
    const files = parsed.matches.map((m) => m.file);
    expect(files).toContain(relFile);
    expect(files).toContain(jsFile);
  });

  it("ast_document_symbols reports unsupported file extensions clearly", async () => {
    const rustFile = "packages/core/src/lib.rs";
    await fs.writeFile(path.join(tmpDir, rustFile), "fn main() {}\n", "utf-8");

    const raw = await astDocumentSymbolsService({ filePath: rustFile });

    expect(raw).toContain("Unsupported file extension for AST scan");
    expect(raw).toContain("ast_* tools currently support JS/TS files");
    expect(raw).not.toContain("interface_declaration");
  });
});
