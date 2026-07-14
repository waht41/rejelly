import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Regex cache for pattern matching performance
 * Prevents repeated regex compilation for the same pattern
 */
const regexCache = new Map<string, RegExp>();

/**
 * Convert glob pattern to regex with caching
 * Supports wildcards: * (matches any chars except /) and ** (matches any chars including /)
 *
 * @param pattern - The glob pattern to convert
 * @returns Compiled RegExp object
 */
function makeRegex(pattern: string): RegExp {
  if (regexCache.has(pattern)) {
    return regexCache.get(pattern)!;
  }

  // Convert glob pattern to regex
  // Escape special regex characters except * and /
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special chars
    .replace(/\*\*/g, "___DS___") // Temporarily replace **
    .replace(/\*/g, "[^/]*") // * matches any chars except /
    .replace(/___DS___/g, ".*"); // ** matches any chars including /

  const regex = new RegExp(`^${source}$`);
  regexCache.set(pattern, regex);
  return regex;
}

/**
 * Check if a file path should be accepted based on blacklist and whitelist
 *
 * New Logic (Hybrid Mode):
 * 1. Whitelist is "Rescue Priority": matching files are ALWAYS included (bypassing blacklist)
 * 2. Blacklist is "Filter": matching files are excluded (unless rescued by whitelist)
 * 3. Default: Files not in either list are INCLUDED
 *
 * @param path - The file path to check
 * @param blacklist - Array of patterns to exclude
 * @param whitelist - Array of patterns to include (used to rescue files from blacklist)
 * @returns True if the file should be included
 */
function isFileAccepted(path: string, blacklist: string[], whitelist: string[]): boolean {
  // 1. Whitelist exemption priority (highest priority)
  // As long as it's in whitelist, regardless of blacklist, force include
  if (whitelist.length > 0) {
    if (whitelist.some((rule) => makeRegex(rule).test(path))) {
      return true;
    }
  }

  // 2. Blacklist filtering
  // If not in whitelist but matches blacklist, exclude
  if (blacklist.some((rule) => makeRegex(rule).test(path))) {
    return false;
  }

  // 3. Default: include (key change)
  // Previous logic had "return false" here when whitelist exists, causing all files
  // except whitelist to be discarded. Changed to "return true" to keep normal files
  // (like api/core.md) that are neither in whitelist nor blacklist
  return true;
}

/**
 * Collect all markdown files from a directory recursively
 * Applies blacklist and whitelist filtering with hybrid mode
 *
 * Hybrid Mode Logic:
 * - Default: All files are included
 * - Blacklist: Excludes matching files
 * - Whitelist: Rescues files from blacklist (whitelist has exemption priority)
 *
 * @param rootDir - The root directory to start collecting from (used as base for relative paths)
 * @param blacklist - Array of patterns to exclude (e.g., ['index.md', 'blog/**', 'temp-*', 'node_modules/**'])
 * @param whitelist - Array of patterns to rescue from blacklist (e.g., ['blog/special.md'])
 *                    Files matching whitelist are always included, even if they match blacklist
 * @returns Array of objects containing path and content of markdown files
 */
export function collectMdFiles(
  rootDir: string,
  blacklist: string[] = [],
  whitelist: string[] = [],
): Array<{ path: string; content: string }> {
  const mdFiles: Array<{ path: string; content: string }> = [];

  /**
   * Recursive directory walker
   * Uses closure to access rootDir, blacklist, and whitelist
   *
   * @param currentDir - Current directory being processed
   */
  function walk(currentDir: string) {
    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      // Calculate relative path from rootDir
      const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        // Directory-level performance optimization
        // Check if current directory matches blacklist using regex (supports wildcards like 'temp-*')
        const isBlacklistedDir = blacklist.some((rule) => makeRegex(rule).test(relPath));

        if (isBlacklistedDir) {
          // Key logic: if whitelist is configured, we need to enter blacklisted directories
          // because there might be whitelist rules like "exclude_dir/but_include_this.md"
          // If no whitelist, we can safely skip the entire directory
          if (whitelist.length === 0) {
            continue;
          }
          // If whitelist exists, continue recursing (walk) and let file-level checks decide
        }

        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (isFileAccepted(relPath, blacklist, whitelist)) {
          mdFiles.push({
            path: relPath,
            content: readFileSync(fullPath, "utf-8"),
          });
        }
      }
    }
  }

  // Start recursion
  walk(rootDir);

  return mdFiles;
}
