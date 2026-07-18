import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCliVersion, parseCliArgs } from "./args";

describe("getCliVersion", () => {
  it("reads the Evil Jelly package version when running from source", () => {
    expect(getCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(getCliVersion()).not.toBe("0.0.0");
  });
});

describe("parseCliArgs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses bare evil as the interactive run command", () => {
    const args = parseCliArgs(["node", "evil", "--api-key", "sk-test-key"]);
    expect(args.kind).toBe("run");
    expect(args.cliApiKey).toBe("sk-test-key");
    if (args.kind !== "run") {
      throw new Error("expected run args");
    }
    expect(args.headless).toBe(false);
    expect(args.autoAccept).toBe(false);
  });

  it("exits directly after cac handles --help", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parseCliArgs(["node", "evil", "--help"])).toThrow("exit 0");
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("--headless");
    expect(help).toContain("requires --input and cannot use --resume, --snapshot, or --mock");
    expect(help).toContain("--mock-inputs");
    expect(help).toContain("requires --mock and cannot be combined with --input");
  });

  it("describes required audit options without a misleading negated default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parseCliArgs(["node", "evil", "audit", "--help"])).toThrow("exit 0");
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("$ evil audit --family <name> [options]");
    expect(help).toContain(
      "Required; one of clone, complexity, fragmentation, doc-drift, or doc-sync",
    );
    expect(help).toContain("--code <path>");
    expect(help).toContain("requires --doc");
    expect(help).not.toContain(
      "--no-ledger-gc        Disable stale ledger pruning for this run (default: true)",
    );
  });

  it("resolves relative workspace paths from the current directory", () => {
    const args = parseCliArgs(["node", "evil", "--workspace", "subdir"]);
    expect(args.workspace).toBe(path.resolve("subdir"));
  });

  it("rejects the removed --cwd option", () => {
    expect(() => parseCliArgs(["node", "evil", "--cwd", "project-a"])).toThrow(
      "Unknown option `--cwd`",
    );
  });

  it("supports init command with API, endpoint, and model options", () => {
    const args = parseCliArgs([
      "node",
      "evil",
      "init",
      "--api-key",
      "sk-global-key",
      "--base-url",
      "https://api.deepseek.com",
      "--model",
      "deepseek-chat",
    ]);
    expect(args.kind).toBe("init");
    expect(args.cliApiKey).toBe("sk-global-key");
    if (args.kind !== "init") {
      throw new Error("expected init args");
    }
    expect(args.initBaseUrl).toBe("https://api.deepseek.com");
    expect(args.initModelId).toBe("deepseek-chat");
  });

  it("parses --headless --input as the direct UnifiedAgent headless mode", () => {
    const args = parseCliArgs(["node", "evil", "--headless", "--input", "hello"]);
    expect(args.kind).toBe("run");
    if (args.kind !== "run") {
      throw new Error("expected run args");
    }
    expect(args.headless).toBe(true);
    expect(args.autoAccept).toBe(false);
    expect(args.startup).toEqual({ kind: "fresh", seedInput: "hello" });
  });

  it("allows explicit --auto-accept only with --headless", () => {
    const args = parseCliArgs(["node", "evil", "--headless", "--auto-accept", "--input", "hello"]);
    expect(args.kind).toBe("run");
    if (args.kind !== "run") {
      throw new Error("expected run args");
    }
    expect(args.autoAccept).toBe(true);
  });

  it("parses run --mock trace replay mode without enabling review", () => {
    const args = parseCliArgs(["node", "evil", "--mock", "trace_123"]);
    expect(args.kind).toBe("run");
    if (args.kind !== "run") {
      throw new Error("expected run args");
    }
    expect(args.startup).toEqual({
      kind: "mock",
      traceId: "trace_123",
      enqueueTraceInputs: false,
    });
    expect(args.review).toBe(false);
  });

  it("parses run --mock with --review as an exported replay", () => {
    const args = parseCliArgs(["node", "evil", "--mock", "trace_123", "--review"]);
    expect(args.kind).toBe("run");
    if (args.kind !== "run") {
      throw new Error("expected run args");
    }
    expect(args.startup).toEqual({
      kind: "mock",
      traceId: "trace_123",
      enqueueTraceInputs: false,
    });
    expect(args.review).toBe(true);
  });

  it("parses run --mock-inputs with --mock", () => {
    const args = parseCliArgs(["node", "evil", "--mock", "trace_123", "--mock-inputs"]);
    expect(args.kind).toBe("run");
    if (args.kind !== "run") {
      throw new Error("expected run args");
    }
    expect(args.startup).toEqual({
      kind: "mock",
      traceId: "trace_123",
      enqueueTraceInputs: true,
    });
  });

  it("parses run --snapshot as a snapshot startup mode", () => {
    const args = parseCliArgs(["node", "evil", "--snapshot", "trace_123", "--input", "continue"]);
    expect(args.kind).toBe("run");
    if (args.kind !== "run") {
      throw new Error("expected run args");
    }
    expect(args.startup).toEqual({
      kind: "snapshot",
      traceId: "trace_123",
      seedInput: "continue",
    });
    expect(args.review).toBe(true);
  });

  it("parses run --resume as a resume startup mode", () => {
    const args = parseCliArgs(["node", "evil", "--resume", "session_123", "--input", "continue"]);
    expect(args.kind).toBe("run");
    if (args.kind !== "run") {
      throw new Error("expected run args");
    }
    expect(args.startup).toEqual({
      kind: "resume",
      sessionId: "session_123",
      seedInput: "continue",
    });
  });

  it("parses settings-override flags into common settings", () => {
    const args = parseCliArgs([
      "node",
      "evil",
      "--devtool",
      "--doc-map",
      "docs/map.jsonc",
      "audit",
      "--family",
      "clone",
      "--max-seeds",
      "48",
      "--ledger-gc-days",
      "10",
      "--no-ledger-gc",
    ]);
    expect(args.settings).toEqual({
      docMap: "docs/map.jsonc",
      devtoolMcp: true,
      auditMaxSeeds: 48,
      auditLedgerGcDays: 10,
      auditDisableLedgerGc: true,
    });
  });

  it("leaves settings overrides undefined when flags are absent", () => {
    const args = parseCliArgs(["node", "evil"]);
    expect(args.settings).toEqual({
      docMap: undefined,
      devtoolMcp: undefined,
      auditMaxSeeds: undefined,
      auditLedgerGcDays: undefined,
      auditDisableLedgerGc: undefined,
    });
  });

  it("parses audit subcommand with family and actionable-only report filters", () => {
    const args = parseCliArgs([
      "node",
      "evil",
      "audit",
      "--family",
      "fragmentation",
      "--only-actionable",
    ]);

    expect(args.kind).toBe("audit");
    if (args.kind !== "audit") {
      throw new Error("expected audit args");
    }
    expect(args.auditOptions).toMatchObject({
      family: "fragmentation",
      onlyActionable: true,
    });
  });

  it("requires an explicit audit family", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parseCliArgs(["node", "evil", "audit"])).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      "audit requires --family <name>. Allowed: clone, complexity, fragmentation, doc-drift, doc-sync",
    );
  });

  it("parses bounded audit seed and ledger GC controls", () => {
    const args = parseCliArgs([
      "node",
      "evil",
      "audit",
      "--family",
      "doc-sync",
      "--max-seeds",
      "64",
      "--ledger-gc-days",
      "7",
      "--no-ledger-gc",
    ]);

    expect(args.kind).toBe("audit");
    if (args.kind !== "audit") {
      throw new Error("expected audit args");
    }
    expect(args.auditOptions).toMatchObject({
      family: "doc-sync",
      maxSeeds: 64,
      ledgerGcDays: 7,
      disableLedgerGc: true,
    });
  });

  it("accepts doc-sync as an audit family", () => {
    const args = parseCliArgs(["node", "evil", "audit", "--family", "doc-sync"]);

    expect(args.kind).toBe("audit");
    if (args.kind !== "audit") {
      throw new Error("expected audit args");
    }
    expect(args.auditOptions).toMatchObject({ family: "doc-sync" });
  });

  it("accepts doc-drift as an audit family", () => {
    const args = parseCliArgs(["node", "evil", "audit", "--family", "doc-drift"]);

    expect(args.kind).toBe("audit");
    if (args.kind !== "audit") {
      throw new Error("expected audit args");
    }
    expect(args.auditOptions).toMatchObject({ family: "doc-drift" });
  });

  it("parses global flags before the audit subcommand", () => {
    const args = parseCliArgs(["node", "evil", "--review", "audit", "--family", "doc-drift"]);

    expect(args.kind).toBe("audit");
    if (args.kind !== "audit") {
      throw new Error("expected audit args");
    }
    expect(args.review).toBe(true);
    expect(args.auditOptions).toMatchObject({ family: "doc-drift" });
  });

  it("rejects a leading separator instead of silently launching interactive Ink", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() =>
      parseCliArgs(["node", "evil", "--", "--review", "audit", "--family", "doc-drift"]),
    ).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      "Unexpected leading `--`: it stops Evil Jelly from parsing the following command. " +
        "When using pnpm, omit it (for example: `pnpm ... start --review audit ...`).",
    );
  });

  it("parses repeated --code paths for a temporary doc-drift run", () => {
    const args = parseCliArgs([
      "node",
      "evil",
      "audit",
      "--family",
      "doc-drift",
      "--doc",
      "README.md",
      "--code",
      "src",
      "--code",
      "packages/core/src",
    ]);

    expect(args.kind).toBe("audit");
    if (args.kind !== "audit") {
      throw new Error("expected audit args");
    }
    expect(args.auditOptions).toMatchObject({
      family: "doc-drift",
      docFilter: "README.md",
      docCodePaths: ["src", "packages/core/src"],
    });
  });

  it("rejects --code without --doc", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() =>
      parseCliArgs(["node", "evil", "audit", "--family", "doc-drift", "--code", "src"]),
    ).toThrow("exit 1");
  });

  it("rejects --doc outside doc-drift audit", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() =>
      parseCliArgs(["node", "evil", "audit", "--family", "clone", "--doc", "README.md"]),
    ).toThrow("exit 1");
  });

  it("rejects audit-only flags on the default command", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parseCliArgs(["node", "evil", "--family", "fragmentation"])).toThrow("exit 1");
  });

  it.each([
    ["all max seeds", ["audit", "--family", "clone", "--max-seeds", "all"]],
    ["zero max seeds", ["audit", "--family", "clone", "--max-seeds", "0"]],
    ["negative max seeds", ["audit", "--family", "clone", "--max-seeds", "-1"]],
    ["zero ledger gc days", ["audit", "--family", "clone", "--ledger-gc-days", "0"]],
  ])("rejects unbounded or invalid numeric audit controls: %s", (_name, argvTail) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parseCliArgs(["node", "evil", ...argvTail])).toThrow("exit 1");
  });

  it.each([
    ["mock and snapshot", ["--mock", "trace_1", "--snapshot", "trace_2"]],
    ["mock and resume", ["--mock", "trace_1", "--resume", "session_1"]],
    ["snapshot and resume", ["--snapshot", "trace_1", "--resume", "session_1"]],
  ])("rejects mutually exclusive run startup modes: %s", (_name, argvTail) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parseCliArgs(["node", "evil", ...argvTail])).toThrow("exit 1");
  });

  it.each([
    ["headless resume", ["--headless", "--resume", "session_1"]],
    ["headless snapshot", ["--headless", "--snapshot", "trace_1"]],
    ["headless mock", ["--headless", "--mock", "trace_1"]],
    ["headless without input", ["--headless"]],
    ["auto accept without headless", ["--auto-accept", "--input", "hello"]],
    ["removed test-unified command", ["test-unified", "hello"]],
  ])("rejects invalid headless args: %s", (_name, argvTail) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() => parseCliArgs(["node", "evil", ...argvTail])).toThrow("exit 1");
  });
});
