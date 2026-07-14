import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 15000,
    setupFiles: ["@rejelly/env/setup"],
  },
});
