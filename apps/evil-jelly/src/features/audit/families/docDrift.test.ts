import { describe, expect, it } from "vitest";
import { candidatesForDoc, docDriftIdentityFor } from "./docDrift";
import { hashMappedImplementationSources, type SurfaceExtraction } from "./surface";

function surface(implementationText: string): SurfaceExtraction {
  return {
    symbols: [
      {
        name: "equipResource",
        kind: "function",
        file: "src/resource.ts",
        line: 10,
        signature: "export function equipResource(value: unknown): void",
        jsdoc: "/** Registers resource cleanup. */",
      },
    ],
    implementationHash: hashMappedImplementationSources([
      { file: "src/resource.ts", text: implementationText },
    ]),
    filesScanned: 1,
    filesParsed: 1,
  };
}

function candidateFor(implementationText: string) {
  const markdown = [
    "## Resource cleanup",
    "The `equipResource` helper automatically cleans up every registered resource after use.",
  ].join("\n");
  const result = candidatesForDoc(
    "docs/resources.md",
    markdown,
    { paths: ["src/resource.ts"] },
    surface(implementationText),
    [],
  );
  return result.candidates[0]!;
}

describe("doc-drift ledger invalidation", () => {
  it("invalidates a section when implementation behavior changes without a surface change", () => {
    const before = docDriftIdentityFor(
      candidateFor(
        "export function equipResource(value: unknown) { if (value) registerCleanup(value); }",
      ),
    );
    const after = docDriftIdentityFor(
      candidateFor(
        "export function equipResource(value: unknown) { if (value != null) registerCleanup(value); }",
      ),
    );

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.contentHash).not.toBe(before.contentHash);
  });
});
