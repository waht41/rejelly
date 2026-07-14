/**
 * Central CLI runner for Rejelly examples.
 *
 * Uses dynamic discovery: scans 01-basics, 02-patterns, 03-real-world for
 * subdirs with index.ts, loads meta from each module (single source of truth).
 *
 * Usage:
 *   pnpm run run                    # interactive: pick module + example
 *   pnpm run run -- --review        # enable Review devtool
 *   pnpm run run -- --otlp          # enable OTLP traces
 *   pnpm run run -- --module=chat-agent --example=default  # direct run (no menu)
 *
 * Debug flags (enableReview / enableOTLP) are applied here so examples
 * don't need to call them; use --review and/or --otlp when needed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enableOTLP, enableReview } from "@rejelly/core/debugger";
import type { ExampleItem, ExampleModule } from "@shared/types";
import prompts from "prompts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_ROOT = path.resolve(__dirname, "..");

const SCAN_DIRS = ["01-basics", "02-patterns", "03-advanced"];

interface ModuleEntry {
  id: string;
  path: string;
  name: string;
  description?: string;
  order: number;
}

/**
 * Discover all example modules by scanning SCAN_DIRS; load meta from each index.ts.
 * Module id = directory name; name/order/description come from meta (single source of truth).
 */
async function discoverModules(): Promise<ModuleEntry[]> {
  const modules: ModuleEntry[] = [];

  for (const dir of SCAN_DIRS) {
    const dirPath = path.resolve(EXAMPLES_ROOT, dir);
    const exists = await fs
      .access(dirPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) continue;

    const subDirs = await fs.readdir(dirPath, { withFileTypes: true });

    for (const dirent of subDirs) {
      if (!dirent.isDirectory()) continue;

      const indexPath = path.join(dirPath, dirent.name, "index.ts");
      const hasIndex = await fs
        .access(indexPath)
        .then(() => true)
        .catch(() => false);
      if (!hasIndex) continue;

      try {
        const url = pathToFileURL(indexPath).href;
        const loaded = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
        if (loaded.meta && typeof loaded.meta === "object") {
          const meta = loaded.meta as { name?: string; description?: string; order?: number };
          modules.push({
            id: dirent.name,
            path: indexPath,
            name: meta.name ?? dirent.name,
            description: meta.description,
            order: meta.order ?? 99,
          });
        }
      } catch (err) {
        console.warn(`⚠️ 无法加载模块元信息: ${dirent.name}`, err);
      }
    }
  }

  return modules.sort((a, b) => a.order - b.order);
}

function parseArgs(): {
  review: boolean;
  otlp: boolean;
  moduleId?: string;
  exampleKey?: string;
} {
  const argv = process.argv.slice(2);
  let moduleId: string | undefined;
  let exampleKey: string | undefined;
  for (const arg of argv) {
    if (arg === "--review") continue;
    if (arg === "--otlp") continue;
    if (arg === "--console") continue;
    if (arg.startsWith("--module=")) moduleId = arg.slice("--module=".length);
    else if (arg.startsWith("--example=")) exampleKey = arg.slice("--example=".length);
  }
  return {
    review: argv.includes("--review"),
    otlp: argv.includes("--otlp"),
    moduleId,
    exampleKey,
  };
}

function applyDebugFlags(opts: { review: boolean; otlp: boolean }) {
  if (opts.review) enableReview({ endpoint: "http://localhost:5789/api/v1/traces" });
  if (opts.otlp) enableOTLP({ endpoint: "http://localhost:4318/v1/traces" });
}

type LoadedModule =
  | { type: "module"; meta: ExampleModule["meta"]; examples: Record<string, ExampleItem> }
  | { type: "single"; run: () => Promise<void>; name: string };

async function loadModule(modulePath: string): Promise<LoadedModule | null> {
  const url = pathToFileURL(modulePath).href;
  const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  if (mod.meta && mod.examples && typeof mod.examples === "object") {
    return {
      type: "module",
      meta: mod.meta as ExampleModule["meta"],
      examples: mod.examples as Record<string, ExampleItem>,
    };
  }
  if (typeof mod.default === "function") {
    return {
      type: "single",
      run: mod.default as () => Promise<void>,
      name: (mod.meta as { name?: string })?.name ?? "Run",
    };
  }
  return null;
}

async function runInteractive() {
  const args = parseArgs();
  applyDebugFlags(args);

  const MODULE_LIST = await discoverModules();
  if (MODULE_LIST.length === 0) {
    console.error("❌ 未发现任何示例模块。");
    process.exit(1);
  }

  const choices = MODULE_LIST.map((m) => ({
    title: m.description ? `${m.name} - ${m.description}` : `${m.name} (${m.id})`,
    value: m.id,
  }));
  const { moduleId: selectedModule } = args.moduleId
    ? { moduleId: args.moduleId }
    : await prompts({
        type: "select",
        name: "moduleId",
        message: "选择示例模块 (Select module):",
        choices,
      });
  const moduleId = selectedModule;
  if (!moduleId) {
    console.log("Cancelled");
    process.exit(0);
  }

  const entry = MODULE_LIST.find((m) => m.id === moduleId);
  if (!entry) {
    console.error("Unknown module:", moduleId);
    process.exit(1);
  }

  const loaded = await loadModule(entry.path);
  if (!loaded) {
    console.error("Module did not export meta+examples or default function:", entry.path);
    process.exit(1);
  }

  if (loaded.type === "single") {
    console.log(`\n🚀 ${loaded.name}...\n`);
    await loaded.run();
    return;
  }

  const exampleEntries = Object.entries(loaded.examples);
  if (exampleEntries.length === 0) {
    console.error("No examples in module");
    process.exit(1);
  }

  let exampleKey = args.exampleKey;
  if (exampleKey === undefined) {
    if (exampleEntries.length === 1) {
      exampleKey = exampleEntries[0][0];
    } else {
      const res = await prompts({
        type: "select",
        name: "exampleKey",
        message: "选择要运行的用例 (Select example):",
        choices: exampleEntries.map(([key, item]) => ({
          title: item.description ? `${item.title} - ${item.description}` : item.title,
          value: key,
        })),
      });
      exampleKey = res.exampleKey;
      if (exampleKey === undefined) {
        console.log("Cancelled");
        process.exit(0);
      }
    }
  }

  const key = exampleKey as string;
  const item = loaded.examples[key];
  if (!item) {
    console.error("Unknown example:", key);
    process.exit(1);
  }

  console.log(`\n🚀 ${item.title}...\n`);
  await item.run();
}

runInteractive().catch((err) => {
  console.error(err);
  process.exit(1);
});
