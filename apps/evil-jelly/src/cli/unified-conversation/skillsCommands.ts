import path from "node:path";
import type { SkillRuntimeSnapshot } from "../../domains/skills/agent/skillRuntime";

const MAX_LIST_ENTRIES = 50;
const MAX_RESOURCE_ENTRIES = 50;
const MAX_DIAGNOSTIC_ENTRIES = 50;
const MAX_LINE_CHARS = 500;

export interface SkillDoctorDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  readonly origin?: { readonly scope: "user" | "project" };
}

export interface SkillDoctorReport {
  readonly snapshot: SkillRuntimeSnapshot;
  readonly diagnostics: readonly SkillDoctorDiagnostic[];
}

export interface SkillsCommandPorts {
  readonly snapshot?: SkillRuntimeSnapshot;
  readonly diagnose?: () => Promise<SkillDoctorReport>;
  logSystem(message: string): void;
}

type SkillsCommand =
  | { readonly kind: "list" }
  | { readonly kind: "show"; readonly name: string }
  | { readonly kind: "doctor" }
  | { readonly kind: "invalid"; readonly message: string };

function parseSkillsCommand(rawInput: string): SkillsCommand | null {
  const args = rawInput.trim().split(/\s+/);
  if (args[0]?.toLocaleLowerCase() !== "/skills") return null;
  if (args.length === 1) return { kind: "list" };

  const action = args[1]?.toLocaleLowerCase();
  if (action === "list") {
    return args.length === 2
      ? { kind: "list" }
      : { kind: "invalid", message: "Usage: /skills list" };
  }
  if (action === "show") {
    return args.length === 3 && args[2]
      ? { kind: "show", name: args[2] }
      : { kind: "invalid", message: "Usage: /skills show <name>" };
  }
  if (action === "doctor") {
    return args.length === 2
      ? { kind: "doctor" }
      : { kind: "invalid", message: "Usage: /skills doctor" };
  }
  return null;
}

export function isSkillsLocalCommand(rawInput: string): boolean {
  return parseSkillsCommand(rawInput) !== null;
}

function qualifiedName(skill: SkillRuntimeSnapshot["catalog"]["entries"][number]): string {
  return `${skill.origin.scope}:${skill.name}`;
}

function boundedLine(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const chars = [...normalized];
  return chars.length <= MAX_LINE_CHARS
    ? normalized
    : `${chars.slice(0, MAX_LINE_CHARS - 1).join("")}…`;
}

function formatList(snapshot: SkillRuntimeSnapshot | undefined): string {
  if (!snapshot) {
    return "Local Skills are unavailable or disabled in this session.\n";
  }
  if (snapshot.catalog.size === 0) {
    return "Local Skills\n\n- (none enabled in this session)\n";
  }
  const visible = snapshot.catalog.entries.slice(0, MAX_LIST_ENTRIES);
  const lines = visible.map((skill) => {
    const description = boundedLine(skill.shortDescription ?? skill.description);
    return `- ${qualifiedName(skill)} — ${description} (${skill.resources.length} resources)`;
  });
  const omitted = snapshot.catalog.size - visible.length;
  if (omitted > 0) {
    lines.push(`- … ${omitted} more omitted; use the $ Skill picker to search by name.`);
  }
  return [
    `Local Skills (${snapshot.catalog.size}, snapshot ${snapshot.catalog.fingerprint})`,
    "",
    ...lines,
    "",
    "Use /skills show <name> for filesystem and resource details.",
    "",
  ].join("\n");
}

function resolveError(
  name: string,
  result: Exclude<ReturnType<SkillRuntimeSnapshot["catalog"]["resolve"]>, { ok: true }>,
): string {
  if (result.reason === "ambiguous") {
    return `Skill name "${name}" is ambiguous. Use one of: ${result.candidates.join(", ")}.\n`;
  }
  const suggestions =
    result.candidates.length > 0 ? ` Similar Skills: ${result.candidates.join(", ")}.` : "";
  return `Skill not found: ${name}.${suggestions}\n`;
}

function formatDetail(snapshot: SkillRuntimeSnapshot | undefined, name: string): string {
  if (!snapshot) {
    return "Local Skills are unavailable or disabled in this session.\n";
  }
  const resolved = snapshot.catalog.resolve(name);
  if (!resolved.ok) return resolveError(name, resolved);

  const { skill } = resolved;
  const access = snapshot.access.get(skill);
  const resources = skill.resources.slice(0, MAX_RESOURCE_ENTRIES);
  const resourceLines = resources.map(
    (resource) => `- ${resource.path} (${resource.kind}, ${resource.sizeBytes} bytes)`,
  );
  if (resourceLines.length === 0) resourceLines.push("- (none)");
  const omitted = skill.resources.length - resources.length;
  if (omitted > 0) resourceLines.push(`- … ${omitted} more resources omitted.`);

  return [
    `Skill ${qualifiedName(skill)}`,
    `Scope: ${skill.origin.scope}`,
    `Description: ${boundedLine(skill.description)}`,
    `Root: ${access.rootPath}`,
    `Main: ${path.join(access.rootPath, access.mainResource)}`,
    `Path convention: ${access.pathConvention}`,
    `Instruction snapshot: ${skill.instruction.length} characters`,
    `Resources (${skill.resources.length}):`,
    ...resourceLines,
    "",
    "The filesystem location is a locator, not a permission grant.",
    "",
  ].join("\n");
}

function formatDoctor(report: SkillDoctorReport): string {
  const diagnostics = report.diagnostics.slice(0, MAX_DIAGNOSTIC_ENTRIES);
  const lines = diagnostics.map((diagnostic) => {
    const scope = diagnostic.origin ? ` [${diagnostic.origin.scope}]` : "";
    const source = diagnostic.source ? ` (${boundedLine(diagnostic.source)})` : "";
    return `- ${diagnostic.code}${scope}: ${boundedLine(diagnostic.message)}${source}`;
  });
  if (lines.length === 0) lines.push("- none");
  const omitted = report.diagnostics.length - diagnostics.length;
  if (omitted > 0) lines.push(`- … ${omitted} more warnings omitted.`);

  return [
    "Skill doctor",
    "Fresh effective scan; the current session snapshot was not replaced.",
    `Loaded: ${report.snapshot.catalog.size}`,
    `Warnings: ${report.diagnostics.length}`,
    ...lines,
    "",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleSkillsCommand(
  rawInput: string,
  ports: SkillsCommandPorts,
): Promise<void> {
  const command = parseSkillsCommand(rawInput);
  if (!command) return;
  if (command.kind === "invalid") {
    ports.logSystem(`${command.message}\n`);
    return;
  }
  if (command.kind === "list") {
    ports.logSystem(formatList(ports.snapshot));
    return;
  }
  if (command.kind === "show") {
    ports.logSystem(formatDetail(ports.snapshot, command.name));
    return;
  }
  if (!ports.diagnose) {
    ports.logSystem("Skill doctor is unavailable in this runtime.\n");
    return;
  }
  try {
    ports.logSystem(formatDoctor(await ports.diagnose()));
  } catch (error) {
    ports.logSystem(`Skill doctor failed: ${errorMessage(error)}\n`);
  }
}
