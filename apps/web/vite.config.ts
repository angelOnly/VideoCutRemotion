import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      "@videocut/contracts": resolve(root, "packages/contracts/src/index.ts"),
      "@videocut/remotion": resolve(root, "packages/remotion-runtime/src/index.tsx")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
