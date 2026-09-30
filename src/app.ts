/**
 * Aupply: Express application (routes only, no listen, no static files).
 *
 * Imported by two entrypoints:
 *   - api/index.ts   Vercel function. Vercel serves the SPA from client/dist
 *                    and rewrites backend paths here (see vercel.json).
 *   - src/server.ts  Local dev and self-hosting. Adds static SPA serving and listen().
 *
 * Routes:
 *   GET  /health
 *   OAuth 2.1 authorization server (MCP SDK mcpAuthRouter + oauthProvider.ts):
 *     GET  /.well-known/oauth-authorization-server
 *     GET  /.well-known/oauth-protected-resource[/mcp]
 *     GET  /authorize  POST /token  POST /register  POST /revoke
 *   Consent (SPA page /oauth/consent calls these, Supabase session required):
 *     GET  /api/oauth/authorization   POST /api/oauth/consent
 *   MCP (Streamable HTTP, OAuth bearer required):
 *     POST /mcp          GET|DELETE /mcp -> 405
 *   Dashboard API (Supabase session required), see src/api/*.ts:
 *     /api/profile /api/experiences /api/educations /api/preferences
 *     /api/resumes /api/answers /api/applications /api/events
 *     /api/runs /api/connections
 *   Billing (untouched until a payment provider is chosen):
 *     /api/stripe/*  /api/user/*
 *
 * Any new top-level backend path must also be added to the rewrites in
 * vercel.json and the dev proxy in vite.config.ts, or it falls through to the SPA.
 *
 * IMPORTANT: The Stripe webhook route uses express.raw() and must be
 * registered BEFORE app.use(express.json()).
 */

import "dotenv/config";
import express, { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { BASE_URL, ISSUER, RESOURCE_URL, SCOPES } from "./config.js";
import { oauthProvider } from "./auth/oauthProvider.js";
import { consentRouter } from "./auth/consentRoutes.js";
import { requireUser } from "./auth/supabaseUser.js";
import { createMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./mcp/server.js";
import { stripeRouter, stripeWebhookHandler } from "./api/stripe.js";
import { userRouter } from "./api/user.js";
import { candidateRouter } from "./api/candidate.js";
import { resumesRouter } from "./api/resumes.js";
import { answersRouter } from "./api/answers.js";
import { applicationsRouter } from "./api/applications.js";
import { accountRouter } from "./api/account.js";
import { apiErrorHandler } from "./api/http.js";

const app = express();

// One proxy hop (Vercel's edge) so req.ip, and the SDK's rate limits, see the client IP.
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// Stripe webhook — MUST be before express.json() (needs raw body)
// ---------------------------------------------------------------------------
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

// ---------------------------------------------------------------------------
// CORS. Auth is bearer tokens, never cookies, so a wildcard origin is safe.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Body parsing for all other routes
// ---------------------------------------------------------------------------
app.use(express.json({ limit: "1mb" }));
// OAuth token requests are form-encoded per RFC 6749.
app.use(express.urlencoded({ extended: false }));

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
// OAuth 2.1 authorization server (discovery, registration, authorize, token, revoke)
// ---------------------------------------------------------------------------
const resourceUrl = new URL(RESOURCE_URL);

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(BASE_URL),
    resourceServerUrl: resourceUrl,
    scopesSupported: [...SCOPES],
    resourceName: MCP_SERVER_NAME,
    // 0 = never expires. The SDK default (30 days) would silently break
    // confidential clients such as Claude a month after connecting.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  })
);

// Some clients look for protected-resource metadata at the root path too.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: RESOURCE_URL,
    authorization_servers: [ISSUER],
    scopes_supported: [...SCOPES],
    resource_name: MCP_SERVER_NAME,
  });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use("/api/oauth", consentRouter);
app.use("/api/stripe", stripeRouter);
app.use("/api/user", userRouter);

const dashboardApi = Router();
dashboardApi.use(requireUser);
dashboardApi.use(candidateRouter, resumesRouter, answersRouter, applicationsRouter, accountRouter);
app.use("/api", dashboardApi);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});
app.use("/api", apiErrorHandler);

// ---------------------------------------------------------------------------
// MCP endpoint — Streamable HTTP, stateless, OAuth bearer required.
// A 401 carries WWW-Authenticate with the resource metadata URL, which is how
// Claude discovers the authorization server.
// ---------------------------------------------------------------------------
const mcpAuth = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
});

app.post("/mcp", mcpAuth, async (req, res) => {
  try {
    const server = createMcpServer();
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

const methodNotAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).json({
    error: "Method Not Allowed",
    description: "This MCP server uses stateless Streamable HTTP (POST only).",
  });
};
app.get("/mcp", mcpAuth, methodNotAllowed);
app.delete("/mcp", mcpAuth, methodNotAllowed);

export default app;
