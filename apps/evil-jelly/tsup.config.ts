import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node18",
  clean: true,
  splitting: true,
  sourcemap: false,
  external: ["undici"],
  // Ink delegates every `<Text wrap="wrap">` to wrap-ansi. Keep the patched
  // CJK-aware implementation in the published executable; leaving it external
  // would make the installed CLI depend on whichever unpatched copy Node finds
  // beside dist at runtime.
  noExternal: ["@rejelly/core", "@rejelly/adapter-openai", "openai", "ink", "wrap-ansi"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __evilCreateRequire } from "node:module";',
      "const require = __evilCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
