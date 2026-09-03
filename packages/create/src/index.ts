import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import prompts from "prompts";
import { ADAPTER_CHOICES, getAdapterPackageName, getAdapterReplacements } from "./adapters";
import {
  applyDefaults,
  assertCompleteOptions,
  type CliOptions,
  getHelpText,
  getMissingOptions,
  parseCliArgs,
  type ScaffoldOptions,
  TEMPLATE_CHOICES,
} from "./cli";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MARKER_IMPORT = "__REJELLY_IMPORT__";
const MARKER_MODEL = "__REJELLY_MODEL__";
const MARKER_DEFAULT_ADAPTER_START = "__REJELLY_DEFAULT_ADAPTER_START__";
const MARKER_DEFAULT_ADAPTER_END = "__REJELLY_DEFAULT_ADAPTER_END__";

// The template AGENTS.md carries a contributor-facing AUTO-GENERATED banner whose
// instructions (edit docs/skill.md, run generate:agents) only make sense inside the
// rejelly monorepo. Swap it for a user-facing note when scaffolding.
const AGENTS_BANNER_PATTERN = /^<!-- AUTO-GENERATED[\s\S]*?-->\s*/;
const AGENTS_USER_BANNER =
  "<!-- Guidance for AI coding assistants, generated from the Rejelly docs by create-rejelly." +
  " This file is yours: feel free to extend it with project-specific instructions. -->";

interface PlaceholderReplacement {
  importLine: string;
  modelLine: string;
}

/** Replace the full line that contains marker. Uses regex so line endings (CRLF/LF) are preserved. */
function replacePlaceholdersInFile(filePath: string, replacement: PlaceholderReplacement): void {
  let content = fs.readFileSync(filePath, "utf-8");
  const { importLine, modelLine } = replacement;
  if (content.includes(MARKER_IMPORT)) {
    content = content.replace(/^.*__REJELLY_IMPORT__.*$/m, importLine);
  }
  if (content.includes(MARKER_MODEL)) {
    content = content.replace(/^.*__REJELLY_MODEL__.*$/m, modelLine);
  }
  // Remove the default stub adapter block (so createMockModel is not left unused after real adapter inject)
  if (
    content.includes(MARKER_DEFAULT_ADAPTER_START) &&
    content.includes(MARKER_DEFAULT_ADAPTER_END)
  ) {
    content = content.replace(
      /^.*__REJELLY_DEFAULT_ADAPTER_START__.*[\r\n]+[\s\S]*?^.*__REJELLY_DEFAULT_ADAPTER_END__.*$/m,
      "",
    );
  }
  fs.writeFileSync(filePath, content, "utf-8");
}

function replacePlaceholdersInTree(dir: string, replacement: PlaceholderReplacement): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") replacePlaceholdersInTree(full, replacement);
    } else if (e.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      const text = fs.readFileSync(full, "utf-8");
      if (
        text.includes(MARKER_IMPORT) ||
        text.includes(MARKER_MODEL) ||
        text.includes(MARKER_DEFAULT_ADAPTER_START)
      ) {
        replacePlaceholdersInFile(full, replacement);
      }
    }
  }
}

async function promptForMissingOptions(options: CliOptions): Promise<ScaffoldOptions> {
  const questions: prompts.PromptObject[] = [];
  if (!options.projectName) {
    questions.push({
      type: "text",
      name: "projectName",
      message: "Project name:",
      initial: "rejelly-app",
    });
  }
  if (!options.template) {
    questions.push({
      type: "select",
      name: "template",
      message: "Which template would you like?",
      choices: [...TEMPLATE_CHOICES],
    });
  }
  if (!options.adapter) {
    questions.push({
      type: "select",
      name: "adapter",
      message: "Which model adapter would you like to start with?",
      choices: [...ADAPTER_CHOICES],
    });
  }

  const response = await prompts(questions, {
    onCancel: () => {
      throw new Error("Operation cancelled.");
    },
  });
  return assertCompleteOptions({ ...options, ...response });
}

async function resolveScaffoldOptions(options: CliOptions): Promise<ScaffoldOptions> {
  if (options.yes) return applyDefaults(options);
  if (getMissingOptions(options).length === 0) return assertCompleteOptions(options);

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return assertCompleteOptions(options);
  return promptForMissingOptions(options);
}

function scaffoldProject({ projectName, template, adapter }: ScaffoldOptions): void {
  const root = path.resolve(process.cwd(), projectName);
  const templateDir = path.resolve(__dirname, `../template-${template}`);
  const sharedDir = path.resolve(__dirname, "../shared");

  if (fs.existsSync(root)) {
    console.log(
      pc.red(`\n  Directory "${projectName}" already exists. Please choose a different name.\n`),
    );
    return;
  }

  console.log(`\n  Scaffolding project in ${pc.green(root)} ...\n`);

  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(templateDir, root, {
    recursive: true,
    filter: (src) => {
      // Use path relative to template dir so we don't exclude files when template lives under .../node_modules/...
      const rel = path.relative(templateDir, src);
      if (rel === "node_modules" || rel.startsWith(`node_modules${path.sep}`)) return false;
      return true;
    },
  });
  fs.cpSync(sharedDir, root, { recursive: true });

  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  pkg.name = projectName;
  for (const depField of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = pkg[depField];
    if (!deps) continue;
    for (const [key, value] of Object.entries(deps)) {
      if (typeof value === "string" && value.startsWith("workspace:")) {
        deps[key] = "latest";
      }
    }
  }
  // Add chosen adapter package (no registry source copy)
  const adapterPkg = getAdapterPackageName(adapter);
  if (!pkg.dependencies) pkg.dependencies = {};
  pkg.dependencies[adapterPkg] = "latest";
  if (pkg.devDependencies) {
    const keep = ["@types/node", "tsx", "typescript", "vitest"];
    pkg.devDependencies = Object.fromEntries(
      keep.map((k) => [k, pkg.devDependencies[k] ?? "latest"]),
    );
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const envExamplePath = path.join(root, ".env.example");
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, path.join(root, ".env"));
    fs.unlinkSync(envExamplePath);
  }

  const replacement = getAdapterReplacements(adapter);
  replacePlaceholdersInTree(root, replacement);

  const agentsPath = path.join(root, "AGENTS.md");
  if (fs.existsSync(agentsPath)) {
    const agentsContent = fs.readFileSync(agentsPath, "utf-8");
    fs.writeFileSync(
      agentsPath,
      agentsContent.replace(AGENTS_BANNER_PATTERN, `${AGENTS_USER_BANNER}\n\n`),
    );
  }

  console.log(pc.green("  Done! Now run:\n"));
  console.log(pc.cyan(`  cd ${projectName}`));
  console.log(pc.cyan("  pnpm install"));
  console.log(pc.cyan("  # edit .env to set your API keys"));
  console.log(pc.cyan("  pnpm start\n"));
}

async function main(): Promise<void> {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (cliOptions.help) {
    console.log(getHelpText());
    return;
  }

  console.log(pc.cyan("\n  Welcome to Create Rejelly!\n"));
  const options = await resolveScaffoldOptions(cliOptions);
  scaffoldProject(options);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(`\n  ${message}\n`));
  console.error(getHelpText());
  process.exitCode = 1;
});
