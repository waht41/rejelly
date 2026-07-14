import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectMdFiles } from "./collect-md-files";

/**
 * Options for generateLlmTxt
 */
export interface GenerateLlmTxtOptions {
  blackList?: string[];
  whiteList?: string[];
}

/**
 * Generate llm.txt file from markdown files
 * This can be run independently without building the entire site
 *
 * @param sourceDir - Source directory containing markdown files (default: process.cwd() or docs directory)
 * @param outputPath - Output path for llm.txt (default: .vitepress/dist/llm.txt relative to sourceDir)
 * @param options - Optional configuration with blackList and whiteList
 */
export function generateLlmTxt(
  sourceDir?: string,
  outputPath?: string,
  options?: GenerateLlmTxtOptions,
): void {
  // Determine directories
  // Default sourceDir: use process.cwd() (assumes running from project root or docs directory)
  // If process.cwd() is docs/.vitepress/utils, go up to docs
  const cwd = process.cwd();
  const defaultSourceDir = cwd.endsWith("docs") ? cwd : resolve(cwd, "docs");
  const defaultOutputPath = join(defaultSourceDir, ".vitepress/dist/llm.txt");

  const srcDir = sourceDir || defaultSourceDir;
  const outPath = outputPath || defaultOutputPath;

  // Define default blacklist and whitelist patterns
  // Patterns support wildcards: * (matches any chars except /) and ** (matches any chars including /)
  const defaultBlackList = [
    ".archived/**", // Unpublished content pulled from the site (VitePress skips dot-dirs, but this walker doesn't)
    "draft/**", // Work-in-progress notes, slated for wholesale deletion
    "index.md", // Root redirect shell to the locale homepage
    "zh/**", // llm.txt exports the en tree only: a bilingual dump doubles tokens with zero information gain (zh stays the source spine via doc-map/doc-sync)
    "en/index.md", // Locale homepage marketing content
    "en/guide/index.md", // Basic introduction (Core docs already cover this)
    ".vitepress/**", // Config files
    "node_modules/**", // Dependencies
    "public/**", // Exclude static assets
    "llm.txt", // Exclude self (prevent circular build issues)
  ];

  const defaultWhiteList: string[] = []; // Whitelist has exemption priority: files matching whitelist are included even if blacklisted

  // Use provided options or defaults
  const blackList = options?.blackList ?? defaultBlackList;
  const whiteList = options?.whiteList ?? defaultWhiteList;

  // Collect markdown files with blacklist/whitelist filtering
  const mdFiles = collectMdFiles(srcDir, blackList, whiteList);

  // Generate content (XML tag format is more friendly for LLM to understand file boundaries, though Markdown headers also work)
  const llmContent = mdFiles
    .map((file) => {
      // Use <file> tag wrapper, which not only distinguishes files but also handles filenames with spaces
      return `<file path="${file.path}">\n${file.content}\n</file>`;
    })
    .join("\n\n");

  // Write to file
  const absoluteOutputPath = resolve(outPath);
  writeFileSync(absoluteOutputPath, llmContent, "utf-8");
  console.log(`✅ llm.txt generated: ${mdFiles.length} files included.`);
  console.log(`   Output: ${absoluteOutputPath}`);
}
