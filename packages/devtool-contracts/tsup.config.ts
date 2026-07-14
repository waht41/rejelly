import { defineConfig } from "tsup";

export default defineConfig({
  tsconfig: "tsconfig.build.json",
  entry: [
    "src/index.ts",
    "src/analyze.ts",
    "src/api.ts",
    "src/trace-filter.ts",
    "src/traces.ts",
    "src/ws-protocol.ts",
  ],
  format: ["esm"],
  target: "node18",
  clean: true,
  dts: true,
  sourcemap: true,
});
