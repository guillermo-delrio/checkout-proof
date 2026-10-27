import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API server (../server/index.ts) listens on 8790; the dev server proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5190, proxy: { "/api": "http://127.0.0.1:8790" } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
});
