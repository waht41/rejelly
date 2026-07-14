import path from "node:path";
import { fileURLToPath } from "node:url";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// FSD: layers from high to low. Lower layers must not import upper layers.
// core has been removed; shared is a single layer (no shared-lib / shared-ui split).
// folder mode: pattern matches parent folder and all files under it (plugin adds **/*).
const elements = [
  { type: "app", pattern: "src/app" },
  { type: "pages", pattern: "src/pages" },
  { type: "widgets", pattern: "src/widgets" },
  { type: "features", pattern: "src/features" },
  { type: "entities", pattern: "src/entities" },
  { type: "shared", pattern: "src/shared" },
];

export default tseslint.config(
  { ...tseslint.configs.base, files: ["src/**/*.ts", "src/**/*.tsx"] },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": elements,
      "boundaries/root-path": path.resolve(__dirname),
      // workspace packages (e.g. @rejelly/core) resolved outside root-path → external, not checked by no-unknown
      "boundaries/flag-as-external": {
        inNodeModules: true,
        unresolvableAlias: true,
        outsideRootPath: true,
        customSourcePatterns: [],
      },
      // resolve FSD layer aliases so boundaries can classify local imports
      "import/resolver": {
        alias: {
          map: [
            ["@app", path.resolve(__dirname, "src/app")],
            ["@pages", path.resolve(__dirname, "src/pages")],
            ["@widgets", path.resolve(__dirname, "src/widgets")],
            ["@features", path.resolve(__dirname, "src/features")],
            ["@entities", path.resolve(__dirname, "src/entities")],
            ["@shared", path.resolve(__dirname, "src/shared")],
          ],
          extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
        },
      },
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            { from: "app", allow: ["pages", "widgets", "features", "entities", "shared"] },
            { from: "pages", allow: ["widgets", "features", "entities", "shared"] },
            { from: "widgets", allow: ["features", "entities", "shared"] },
            { from: "features", allow: ["entities", "shared"] },
            { from: "entities", allow: ["shared"] },
            { from: "shared", allow: ["shared"] },
          ],
        },
      ],
      "boundaries/no-unknown": "error",
      "boundaries/no-unknown-files": "error",
    },
  },
);
