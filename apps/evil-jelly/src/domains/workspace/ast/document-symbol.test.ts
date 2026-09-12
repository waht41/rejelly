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

  it("ast_document_symbols returns a compact source-order outline", async () => {
    const raw = await astDocumentSymbolsService({ filePath: relFile });
    const privateIndex = raw.indexOf("fn _parseAndValidate(input) → boolean");
    const equipIndex = raw.indexOf(
      "export fn equipSystem(amount) → string — Equip the budget system for runtime checks.",
    );
    const mergeIndex = raw.indexOf("export const itemMergeKey — Merge by item id");

    expect(raw.startsWith(`${relFile}\n\n`)).toBe(true);
    expect(privateIndex).toBeGreaterThan(0);
    expect(equipIndex).toBeGreaterThan(privateIndex);
    expect(mergeIndex).toBeGreaterThan(equipIndex);
    expect(raw).not.toContain('"description": null');
    expect(raw).not.toContain('"signature"');
  });

  it("ast_document_symbols can filter to exported declarations", async () => {
    const raw = await astDocumentSymbolsService({ filePath: relFile, include: "exported" });

    expect(raw).not.toContain("_parseAndValidate");
    expect(raw).toContain("export fn equipSystem(amount) → string");
    expect(raw).toContain("export const itemMergeKey");
  });

  it("ast_document_symbols indents class members and compacts parameters", async () => {
    const classFile = "packages/core/src/box.ts";
    await fs.writeFile(
      path.join(tmpDir, classFile),
      [
        "export class Box {",
        "  constructor(value: string, enabled = true) {}",
        "  async run(input: number): Promise<boolean> { return true }",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const raw = await astDocumentSymbolsService({ filePath: classFile });

    expect(raw).toContain("1  export class Box");
    expect(raw).toContain("2    constructor(value, enabled?)");
    expect(raw).toContain("3    async run(input) → boolean");
  });

  it("ast_read_symbol_code returns unescaped declaration source", async () => {
    const raw = await astReadSymbolCodeService({
      filePath: relFile,
      symbolName: ["equipSystem", "missingSymbol"],
      caseInsensitive: false,
    });

    expect(raw.startsWith(`${relFile}\n\nequipSystem\n`)).toBe(true);
    expect(raw).toContain("8  function_declaration");
    expect(raw).toContain("signature: function equipSystem(amount: number): string");
    expect(raw).toContain("jsdoc: Equip the budget system for runtime checks.");
    expect(raw).toContain(
      [
        "code:",
        "export function equipSystem(amount: number): string {",
        "  return String(amount)",
        "}",
      ].join("\n"),
    );
    expect(raw).toContain("missingSymbol\n  (no matching declarations)");
    expect(raw).not.toContain('"code"');
    expect(raw).not.toContain("\\n");
  });

  it("confirms and parses one outside source file", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-outside-ast-"));
    const outsideFile = path.join(outsideDir, "external.ts");
    await fs.writeFile(outsideFile, "export function outsideSymbol() { return true }\n", "utf8");
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "normal", outsideAccessRequests });

    try {
      const raw = await astDocumentSymbolsService({ filePath: outsideFile });

      expect(outsideAccessRequests).toHaveLength(1);
      expect(raw).toContain(outsideFile.replace(/\\/g, "/"));
      expect(raw).toContain("export fn outsideSymbol()");
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

      expect(outsideAccessRequests).toHaveLength(1);
      expect(outsideAccessRequests[0]?.access).toBe("scan");
      expect(raw).toContain(`roots: ${outsideDir.replace(/\\/g, "/")}`);
      expect(raw).toContain(
        `${path.join(outsideDir, "external.ts").replace(/\\/g, "/")}:1  variable outsideRootSymbol`,
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("ast_document_symbols includes re-export barrel entries", async () => {
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

    const raw = await astDocumentSymbolsService({ filePath: barrel, include: "exported" });

    expect(raw).toContain("export type { BudgetConfig, BudgetState } from './core/context/budget'");
    expect(raw).toContain("export { createAgent } from './core/engine/agent'");
    expect(raw).toContain("export * from './core/primitives/run'");
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

    expect(raw.startsWith("equipSystem\n\n")).toBe(true);
    expect(raw).toContain(`${relFile}:8  function equipSystem`);
    expect(raw).toContain(`${jsFile}:1  function equipSystem`);
    expect(raw).not.toContain('"matches"');
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
