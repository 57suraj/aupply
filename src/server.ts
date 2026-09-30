/**
 * Aupply — Server entry point
 *
 * Routes:
 *   GET  /health                          — health check
 *   GET  /oauth/authorize                 — OAuth authorization redirect
 *   POST /oauth/token                     — OAuth token exchange
 *   GET  /oauth/callback                  — OAuth callback (for reference)
 *   POST /api/oauth/consent               — consent submission (frontend → backend)
 *   GET  /api/user/me                     — current user info
 *   GET  /api/user/subscription           — subscription status
 *   POST /api/stripe/create-checkout-session
 *   POST /api/stripe/billing-portal
 *   POST /api/stripe/webhook              — Stripe webhook (raw body)
 *   POST /mcp                             — MCP Streamable HTTP
 *   GET  /mcp                             — 405 (not SSE)
 *   *    (production)                     — SPA fallback (serves index.html)
 *
 * IMPORTANT: The Stripe webhook route uses express.raw() and must be
 * registered BEFORE app.use(express.json()).
 */

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  getAuthenticatedUser,
  AuthenticationError,
} from "./auth/getAuthenticatedUser.js";
import { handleAuthorize, handleCallback, handleToken, oauthRouter } from "./auth/oauth.js";
import { createMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./mcp/server.js";
import { stripeRouter, stripeWebhookHandler } from "./api/stripe.js";
import { userRouter } from "./api/user.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Stripe webhook — MUST be before express.json() (needs raw body)
// ---------------------------------------------------------------------------
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

// ---------------------------------------------------------------------------
// Body parsing for all other routes
// ---------------------------------------------------------------------------
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS headers (permissive in dev; tighten in production)
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// OAuth routes
// ---------------------------------------------------------------------------
app.get("/oauth/authorize", handleAuthorize);
app.get("/oauth/callback", handleCallback);
app.post("/oauth/token", handleToken);

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use("/api/oauth", oauthRouter);
app.use("/api/stripe", stripeRouter);
app.use("/api/user", userRouter);

// ---------------------------------------------------------------------------
// MCP endpoint — Streamable HTTP
// ---------------------------------------------------------------------------
app.post("/mcp", async (req, res) => {
  const capturedReq = req;
  const getUser = () => getAuthenticatedUser(capturedReq);

  try {
    if (!isInitializeRequest(req.body)) {
      try {
        await getUser();
      } catch (err) {
        if (err instanceof AuthenticationError) {
          res.status(err.statusCode).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: err.message },
            id: req.body?.id ?? null,
          });
          return;
        }
        throw err;
      }
    }

    const server = createMcpServer(getUser);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] Unhandled error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: req.body?.id ?? null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    error: "Method Not Allowed",
    description: "This MCP server uses Streamable HTTP (POST only).",
  });
});

// ---------------------------------------------------------------------------
// Production: serve the React SPA
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV === "production") {
  const clientDist = path.join(__dirname, "../client/dist");
  app.use(express.static(clientDist));

  // SPA fallback — serve index.html for all unmatched routes
  app.get("*", (_req, res) => {
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

export default app;
