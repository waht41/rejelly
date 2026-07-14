import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node18",
  clean: true,
  splitting: false,
  sourcemap: false,
  external: ["undici"],
  noExternal: ["@rejelly/core", "@rejelly/adapter-openai", "openai", "ink"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __evilCreateRequire } from "node:module";',
      "const require = __evilCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
