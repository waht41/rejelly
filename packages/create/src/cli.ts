import type { AdapterChoice } from "./adapters";

export const TEMPLATE_CHOICES = [
  { title: "Basic (chat)", value: "basic" as const },
  { title: "Router", value: "router" as const },
] as const;

export type TemplateChoice = (typeof TEMPLATE_CHOICES)[number]["value"];

export interface ScaffoldOptions {
  projectName: string;
  template: TemplateChoice;
  adapter: AdapterChoice;
}

export interface CliOptions extends Partial<ScaffoldOptions> {
  help: boolean;
  yes: boolean;
}

const DEFAULT_OPTIONS: ScaffoldOptions = {
  projectName: "rejelly-app",
  template: "basic",
  adapter: "openai",
};

const TEMPLATE_VALUES = new Set<TemplateChoice>(TEMPLATE_CHOICES.map(({ value }) => value));
const ADAPTER_VALUES = new Set<AdapterChoice>(["openai", "gemini"]);

function readOptionValue(argv: string[], index: number, option: string): [string, number] {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return [value, index + 1];
}

export function parseCliArgs(argv: string[]): CliOptions {
  const result: CliOptions = { help: false, yes: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      result.yes = true;
      continue;
    }

    let option: "--template" | "--adapter" | undefined;
    let value: string | undefined;
    if (arg === "--template" || arg === "-t") {
      option = "--template";
      [value, index] = readOptionValue(argv, index, arg);
    } else if (arg.startsWith("--template=")) {
      option = "--template";
      value = arg.slice("--template=".length);
    } else if (arg === "--adapter" || arg === "-a") {
      option = "--adapter";
      [value, index] = readOptionValue(argv, index, arg);
    } else if (arg.startsWith("--adapter=")) {
      option = "--adapter";
      value = arg.slice("--adapter=".length);
    }

    if (option === "--template") {
      if (!TEMPLATE_VALUES.has(value as TemplateChoice)) {
        throw new Error(`Invalid template "${value}". Expected: basic or router.`);
      }
      result.template = value as TemplateChoice;
      continue;
    }
    if (option === "--adapter") {
      if (!ADAPTER_VALUES.has(value as AdapterChoice)) {
        throw new Error(`Invalid adapter "${value}". Expected: openai or gemini.`);
      }
      result.adapter = value as AdapterChoice;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    }
    if (result.projectName) {
      throw new Error(`Unexpected positional argument "${arg}".`);
    }
    result.projectName = arg;
  }

  return result;
}

export function getMissingOptions(options: CliOptions): Array<keyof ScaffoldOptions> {
  const missing: Array<keyof ScaffoldOptions> = [];
  if (!options.projectName) missing.push("projectName");
  if (!options.template) missing.push("template");
  if (!options.adapter) missing.push("adapter");
  return missing;
}

export function applyDefaults(options: CliOptions): ScaffoldOptions {
  return {
    projectName: options.projectName ?? DEFAULT_OPTIONS.projectName,
    template: options.template ?? DEFAULT_OPTIONS.template,
    adapter: options.adapter ?? DEFAULT_OPTIONS.adapter,
  };
}

export function assertCompleteOptions(options: CliOptions): ScaffoldOptions {
  const missing = getMissingOptions(options);
  if (missing.length > 0) {
    throw new Error(
      `Missing required options in non-interactive mode: ${missing.join(", ")}. Pass all values or use --yes for defaults.`,
    );
  }
  return options as ScaffoldOptions;
}

export function getHelpText(): string {
  return `Usage: create-rejelly [project-name] [options]

Options:
  -t, --template <basic|router>   Project template
  -a, --adapter <openai|gemini>  Model adapter
  -y, --yes                      Use defaults for missing values
  -h, --help                     Show this help

Examples:
  create-rejelly my-app --template basic --adapter openai
  create-rejelly my-app --yes`;
}
