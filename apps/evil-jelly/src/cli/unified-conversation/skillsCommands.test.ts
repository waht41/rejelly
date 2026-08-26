import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SkillRuntimeSnapshot } from "../../domains/skills/agent/skillRuntime";
import type { SkillsCommandPorts } from "./skillsCommands";
import { handleSkillsCommand, isSkillsLocalCommand } from "./skillsCommands";

type SkillRecord = SkillRuntimeSnapshot["catalog"]["entries"][number];

function record(scope: "user" | "project", name: string): SkillRecord {
  return {
    name,
    description: `Full description for ${name}`,
    shortDescription: `Short description for ${name}`,
    origin: { scope },
    instruction: `Instructions for ${name}`,
    resources: [{ path: "references/guide.md", kind: "reference", sizeBytes: 42 }],
  };
}

function runtime(records: readonly SkillRecord[]): SkillRuntimeSnapshot {
  const resolve: SkillRuntimeSnapshot["catalog"]["resolve"] = (input) => {
    const name = input.trim();
    const matching = records.filter((skill) =>
      name.includes(":") ? `${skill.origin.scope}:${skill.name}` === name : skill.name === name,
    );
    if (matching.length === 1) return { ok: true, skill: matching[0]! };
    return {
      ok: false,
      reason: matching.length > 1 ? "ambiguous" : "not-found",
      candidates:
        matching.length > 1
          ? matching.map((skill) => `${skill.origin.scope}:${skill.name}`)
          : records.slice(0, 5).map((skill) => `${skill.origin.scope}:${skill.name}`),
    };
  };
  return {
    catalog: {
      size: records.length,
      fingerprint: "1234abcd",
      entries: records,
      resolve,
      list: vi.fn(() => ({
        ok: true as const,
        page: { items: [], returned: 0, total: records.length },
      })),
    },
    access: {
      get(skill) {
        return {
          kind: "host-filesystem",
          rootPath: path.join("C:\\skills", skill.origin.scope, skill.name),
          mainResource: "SKILL.md",
          pathConvention: "windows",
        };
      },
    },
    resources: {
      readText: vi.fn(async () => ({
        ok: false as const,
        reason: "resource-not-listed" as const,
        message: "not used",
      })),
    },
  };
}

function ports(snapshot?: SkillRuntimeSnapshot) {
  const logSystem = vi.fn<(message: string) => void>();
  return { snapshot, logSystem } satisfies SkillsCommandPorts;
}

describe("local Skills commands", () => {
  it("reserves only the supported command grammar", () => {
    expect(isSkillsLocalCommand("/skills")).toBe(true);
    expect(isSkillsLocalCommand("/skills list")).toBe(true);
    expect(isSkillsLocalCommand("/skills show project:review")).toBe(true);
    expect(isSkillsLocalCommand("/skills doctor")).toBe(true);
    expect(isSkillsLocalCommand("/skills show")).toBe(true);
    expect(isSkillsLocalCommand("/skills 是怎么实现的？")).toBe(false);
    expect(isSkillsLocalCommand("/skill")).toBe(false);
  });

  it("lists the frozen session catalog without filesystem locations", async () => {
    const command = ports(runtime([record("project", "review"), record("user", "explain")]));

    await handleSkillsCommand("/skills list", command);

    const output = command.logSystem.mock.calls[0]?.[0] as string;
    expect(output).toContain("Local Skills (2, snapshot 1234abcd)");
    expect(output).toContain("project:review — Short description for review (1 resources)");
    expect(output).toContain("user:explain — Short description for explain (1 resources)");
    expect(output).not.toContain("C:\\skills");
  });

  it("opens the Skill manager, enters detail, and opens the selected folder", async () => {
    const snapshot = runtime([record("project", "review"), record("user", "explain")]);
    const requestSkillManager = vi
      .fn()
      .mockResolvedValueOnce({ action: "detail" as const, qualifiedName: "project:review" })
      .mockResolvedValueOnce({ action: "open_folder" as const, qualifiedName: "project:review" })
      .mockResolvedValueOnce({ action: "close" as const });
    const openSkillFolder = vi.fn(async () => undefined);
    const command = { ...ports(snapshot), requestSkillManager, openSkillFolder };

    await handleSkillsCommand("/skills", command);

    expect(requestSkillManager).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ qualifiedName: "project:review", resourceCount: 1 }),
        ]),
        canOpenFolder: true,
      }),
    );
    expect(requestSkillManager.mock.calls[0]?.[0]).not.toHaveProperty("detail");
    expect(requestSkillManager).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        detail: expect.objectContaining({
          qualifiedName: "project:review",
          rootPath: path.join("C:\\skills", "project", "review"),
          mainPath: path.join("C:\\skills", "project", "review", "SKILL.md"),
          resources: [{ path: "references/guide.md", kind: "reference", sizeBytes: 42 }],
        }),
      }),
    );
    expect(openSkillFolder).toHaveBeenCalledWith(path.join("C:\\skills", "project", "review"));
    expect(requestSkillManager).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ message: "Opened project:review in the file manager." }),
    );
    expect(command.logSystem).not.toHaveBeenCalled();
  });

  it("falls back to text when the host has no Skill manager", async () => {
    const command = ports(runtime([record("project", "review")]));

    await handleSkillsCommand("/skills", command);

    expect(command.logSystem).toHaveBeenCalledWith(expect.stringContaining("project:review"));
  });

  it("requires a qualifier for ambiguous names", async () => {
    const command = ports(runtime([record("project", "review"), record("user", "review")]));

    await handleSkillsCommand("/skills show review", command);

    expect(command.logSystem).toHaveBeenCalledWith(
      expect.stringContaining("project:review, user:review"),
    );
  });

  it("shows the host locator and inventoried resources for one Skill", async () => {
    const command = ports(runtime([record("project", "review")]));

    await handleSkillsCommand("/skills show project:review", command);

    const output = command.logSystem.mock.calls[0]?.[0] as string;
    expect(output).toContain("Skill project:review");
    expect(output).toContain(`Root: ${path.join("C:\\skills", "project", "review")}`);
    expect(output).toContain(`Main: ${path.join("C:\\skills", "project", "review", "SKILL.md")}`);
    expect(output).toContain("references/guide.md (reference, 42 bytes)");
    expect(output).toContain("locator, not a permission grant");
    expect(output).not.toContain("Instructions for review");
  });

  it("runs a fresh diagnostic scan without replacing the session snapshot", async () => {
    const current = runtime([record("project", "review")]);
    const fresh = runtime([record("project", "review"), record("user", "explain")]);
    const diagnose = vi.fn(async () => ({
      snapshot: fresh,
      diagnostics: [
        {
          code: "skill.frontmatter.invalid",
          message: "Invalid frontmatter",
          source: "C:\\skills\\broken\\SKILL.md",
          origin: { scope: "user" as const },
        },
      ],
    }));
    const command = { ...ports(current), diagnose };

    await handleSkillsCommand("/skills doctor", command);

    expect(diagnose).toHaveBeenCalledOnce();
    const output = command.logSystem.mock.calls[0]?.[0] as string;
    expect(output).toContain("current session snapshot was not replaced");
    expect(output).toContain("Loaded: 2");
    expect(output).toContain("Warnings: 1");
    expect(output).toContain("skill.frontmatter.invalid [user]");
    expect(current.catalog.size).toBe(1);
  });

  it("reports malformed and unavailable commands locally", async () => {
    const command = ports();

    await handleSkillsCommand("/skills show", command);
    await handleSkillsCommand("/skills doctor", command);

    expect(command.logSystem).toHaveBeenNthCalledWith(1, "Usage: /skills show <name>\n");
    expect(command.logSystem).toHaveBeenNthCalledWith(
      2,
      "Skill doctor is unavailable in this runtime.\n",
    );
  });
});
