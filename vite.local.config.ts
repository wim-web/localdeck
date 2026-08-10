import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "local",
  publicDir: false,
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4545",
    },
  },
  build: {
    outDir: "../dist-local",
    emptyOutDir: true,
    sourcemap: true,
  },
});
