import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  build: {
    outDir: "client/dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Forward all backend routes to Express
      "/mcp": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/api": "http://localhost:3000",
      "/oauth/authorize": "http://localhost:3000",
      "/oauth/token": "http://localhost:3000",
      "/oauth/callback": "http://localhost:3000",
    },
  },
});
