import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Build into this package's own dist; devtool-server copies it into dist/public
    // during its build (after tsup clean). Keeping outputs disjoint lets turbo cache
    // both packages correctly and avoids the double-build / clean race.
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@app": path.resolve(__dirname, "src/app"),
      "@pages": path.resolve(__dirname, "src/pages"),
      "@widgets": path.resolve(__dirname, "src/widgets"),
      "@features": path.resolve(__dirname, "src/features"),
      "@entities": path.resolve(__dirname, "src/entities"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  server: {
    proxy: {
      // API proxy
      "/api": {
        target: "http://127.0.0.1:5789",
        changeOrigin: true,
      },
      // WebSocket proxy
      "/ws": {
        target: "ws://127.0.0.1:5789",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
