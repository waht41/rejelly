import type { CAC } from "cac";

function failArgs(message: string): never {
  console.error(message);
  process.exit(1);
}

export type SkillManagementCommand =
  | { readonly action: "list" }
  | { readonly action: "show"; readonly name: string }
  | { readonly action: "doctor" };

export interface SkillsCommandArgs {
  readonly kind: "skills";
  readonly skillCommand: SkillManagementCommand;
}

export function registerSkillsArgs(cli: CAC): void {
  cli
    .command("skills [...skillArgs]", "Inspect local Skills")
    .usage("skills list|show|doctor [name]");
}

function assertNoExtraArgs(args: readonly string[], action: string): void {
  if (args.length > 0) failArgs(`Unknown skills ${action} argument: ${args[0]}`);
}

export function parseSkillsArgs(args: readonly string[]): SkillsCommandArgs {
  const [rawAction = "list", rawName, ...rest] = args;
  switch (rawAction) {
    case "list":
      if (rawName !== undefined) failArgs(`Unknown skills list argument: ${rawName}`);
      return { kind: "skills", skillCommand: { action: "list" } };
    case "show": {
      const name = rawName?.trim();
      if (!name) failArgs("skills show requires <name>.");
      assertNoExtraArgs(rest, "show");
      return { kind: "skills", skillCommand: { action: "show", name } };
    }
    case "doctor":
      if (rawName !== undefined) failArgs(`Unknown skills doctor argument: ${rawName}`);
      return { kind: "skills", skillCommand: { action: "doctor" } };
    default:
      failArgs(`Unknown skills action "${rawAction}". Allowed: list, show, doctor.`);
  }
}
