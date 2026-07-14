/**
 * Coding tools: the five primitives of a coding agent, written natively.
 *
 * The point of this file is its size: a workable file/shell toolset is a few
 * dozen lines each. Tools are plain objects ({ name, description, parameters,
 * handler }) — no registry, no decorators — so a factory closure is all it
 * takes to bind them to a sandbox root.
 *
 * Every path is resolved through resolveInWorkspace: relative to the workspace
 * root, and rejected if it escapes it. run_command executes with cwd pinned to
 * the workspace for the same reason.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";

const execAsync = promisify(exec);

/** Tools that mutate the workspace or execute code — these get the approval gate. */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "run_command",
]);

/** Cap tool output so a huge file or chatty command can't flood the context. */
const MAX_OUTPUT_CHARS = 20_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated, ${text.length} chars total)`;
}

/** Resolve a workspace-relative path; throw if it escapes the sandbox root. */
function resolveInWorkspace(workspaceRoot: string, relativePath: string): string {
  const resolved = path.resolve(workspaceRoot, relativePath);
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace sandbox: ${relativePath}`);
  }
  return resolved;
}

async function listFilesRecursive(dir: string, root: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full, root)));
    } else {
      // Always report forward-slash relative paths so the model sees one path
      // style regardless of host OS.
      files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return files;
}

/**
 * Build the toolset bound to one workspace root.
 *
 * Returned tools are ordinary ToolDefinition objects; equip them with
 * `equipTool(tool)` inside an agent handler.
 */
export function createCodingTools(workspaceRoot: string): ToolDefinition<any>[] {
  const listFiles: ToolDefinition<z.ZodObject<Record<string, never>>> = {
    name: "list_files",
    description:
      "List every file in the workspace (recursive, relative paths). Use this first to orient yourself.",
    parameters: z.object({}),
    handler: async () => {
      const files = await listFilesRecursive(workspaceRoot, workspaceRoot);
      return files.length === 0 ? "(workspace is empty)" : files.join("\n");
    },
  };

  const readFileParams = z.object({
    path: z.string().min(1).describe("Workspace-relative file path to read."),
  });
  const readFile: ToolDefinition<typeof readFileParams> = {
    name: "read_file",
    description: "Read a file's full content. Read before you edit.",
    parameters: readFileParams,
    handler: async ({ path: relPath }) => {
      const content = await fs.readFile(resolveInWorkspace(workspaceRoot, relPath), "utf-8");
      return truncate(content);
    },
  };

  const writeFileParams = z.object({
    path: z.string().min(1).describe("Workspace-relative file path to create or overwrite."),
    content: z.string().describe("Full file content."),
  });
  const writeFile: ToolDefinition<typeof writeFileParams> = {
    name: "write_file",
    description:
      "Create a new file or overwrite an existing one with the given content. " +
      "Parent directories are created as needed. For small changes to an existing file prefer edit_file.",
    parameters: writeFileParams,
    handler: async ({ path: relPath, content }) => {
      const target = resolveInWorkspace(workspaceRoot, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf-8");
      return `Wrote ${content.length} chars to ${relPath}`;
    },
  };

  const editFileParams = z.object({
    path: z.string().min(1).describe("Workspace-relative file path to edit."),
    old_string: z
      .string()
      .min(1)
      .describe("Exact text to replace. Must appear exactly once in the file."),
    new_string: z.string().describe("Replacement text."),
  });
  const editFile: ToolDefinition<typeof editFileParams> = {
    name: "edit_file",
    description:
      "Replace one exact, unique occurrence of old_string with new_string in a file. " +
      "Fails if old_string is missing or ambiguous — include enough surrounding context to make it unique.",
    parameters: editFileParams,
    handler: async ({ path: relPath, old_string, new_string }) => {
      const target = resolveInWorkspace(workspaceRoot, relPath);
      const content = await fs.readFile(target, "utf-8");
      const first = content.indexOf(old_string);
      if (first === -1) {
        return `Edit failed: old_string not found in ${relPath}. Read the file and retry with exact text.`;
      }
      if (content.indexOf(old_string, first + 1) !== -1) {
        return `Edit failed: old_string appears more than once in ${relPath}. Add surrounding context to make it unique.`;
      }
      await fs.writeFile(
        target,
        content.slice(0, first) + new_string + content.slice(first + old_string.length),
        "utf-8",
      );
      return `Edited ${relPath}`;
    },
  };

  const runCommandParams = z.object({
    command: z
      .string()
      .min(1)
      .describe("Single shell command to run in the workspace root (e.g. `node test.js`)."),
  });
  const runCommand: ToolDefinition<typeof runCommandParams> = {
    name: "run_command",
    description:
      "Run a shell command with cwd at the workspace root and return exit code, stdout and stderr. " +
      "Runs through the host platform shell. Use it to verify your changes actually work.",
    parameters: runCommandParams,
    handler: async ({ command }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workspaceRoot,
          timeout: 30_000,
        });
        return truncate(`exit code: 0\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      } catch (error) {
        // exec rejects on non-zero exit; surface it as a normal tool result so
        // the model can read the failure and iterate instead of crashing the run.
        const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
        return truncate(
          `exit code: ${err.code ?? "unknown"}\nstdout:\n${err.stdout ?? ""}\nstderr:\n${err.stderr ?? err.message ?? ""}`,
        );
      }
    },
  };

  return [listFiles, readFile, writeFile, editFile, runCommand];
}
