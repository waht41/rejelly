import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node18",
  // Published CLI builds must not retain React's development-only User Timing entries.
  // This is a compile-time choice, not a mutation of the user's process environment;
  // source development and the explicit startup/composer profilers remain unchanged.
  define: { "process.env.NODE_ENV": '"production"' },
  clean: true,
  splitting: true,
  sourcemap: false,
  external: ["undici"],
  // The Markdown parser is a graph of many small ESM packages. Prebundle it so CLI startup does
  // not spend most of cliBinding import time resolving and statting those packages individually.
  // The MCP SDK and adapter independently load different AJV entrypoints. Bundle both parents so
  // esbuild can collapse their shared schema-validation graph; leaving either parent external
  // still makes Node load AJV and its many modules at startup.
  // Ink delegates every `<Text wrap="wrap">` to wrap-ansi. Keep the patched
  // CJK-aware implementation in the published executable; leaving it external
  // would make the installed CLI depend on whichever unpatched copy Node finds
  // beside dist at runtime.
  noExternal: [
    "@rejelly/core",
    "@rejelly/adapter-mcp",
    "@rejelly/adapter-openai",
    "@modelcontextprotocol/sdk",
    "openai",
    "ink",
    // Keep the renderer, JSX runtime, and store hooks on one bundled production React.
    // External React consumers would otherwise load another, environment-selected copy.
    "react",
    "zustand",
    // Skills and the MCP SDK otherwise load large YAML/Zod module trees at startup.
    // Include Zod subpaths as well so the SDK's v3/v4 compatibility imports are bundled.
    "yaml",
    "zod",
    "zod-to-json-schema",
    "remark-cjk-friendly",
    "remark-gfm",
    "remark-parse",
    "unified",
    "wrap-ansi",
  ],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __evilCreateRequire } from "node:module";',
      "const require = __evilCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
