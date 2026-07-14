import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/cli-entry.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  // Runtime assets are copied by postbuild after server output is cleaned.
  clean: true,
  splitting: true,
  treeshake: true,
  // No DTS: this is a CLI app (bin only), nothing consumes it as a typed module.
  dts: false,
  external: ["better-sqlite3"],
  noExternal: ["@rejelly/devtool-contracts"],
});
