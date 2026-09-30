/**
 * Aupply: standalone server entrypoint (local dev and self-hosting).
 *
 * On Vercel this file is not used: api/index.ts imports the app directly and
 * Vercel serves the SPA. Routes live in ./app.ts.
 */

import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import app from "./app.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./mcp/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Production (self-hosted): serve the React SPA
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV === "production") {
  const clientDist = path.join(__dirname, "../client/dist");
  app.use(express.static(clientDist));

  // SPA fallback. Express 5 needs a named wildcard; a bare "*" throws at startup.
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🚀 ${MCP_SERVER_NAME} v${MCP_SERVER_VERSION}`);
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   MCP:    http://localhost:${PORT}/mcp`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   OAuth:  http://localhost:${PORT}/oauth/*`);
  console.log(`   API:    http://localhost:${PORT}/api/*`);
  console.log(`   Env:    ${process.env.NODE_ENV ?? "development"}\n`);
});
