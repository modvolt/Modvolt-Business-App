import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname, "src/client"),
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
});
