import fs from "node:fs";
import { defineConfig } from "tsup";

function readPackageVersion(relativePath: string): string {
  const pkg = JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), "utf-8"));
  return pkg.version;
}

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  define: {
    __REJELLY_CORE_VERSION__: JSON.stringify(readPackageVersion("../core/package.json")),
    __REJELLY_OPENAI_VERSION__: JSON.stringify(
      readPackageVersion("../adapters/openai/package.json"),
    ),
    __REJELLY_GEMINI_VERSION__: JSON.stringify(
      readPackageVersion("../adapters/gemini/package.json"),
    ),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
