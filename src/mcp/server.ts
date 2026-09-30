/**
 * MCP Server factory.
 *
 * Creates and configures the McpServer instance with all registered tools.
 * The server uses the Streamable HTTP transport (handled by the SDK).
 *
 * This module is transport-agnostic — it does not know about Express or HTTP.
 * Transport wiring lives in src/server.ts.
 *
 * Tool handlers receive a `getUser` thunk that is bound per-request in server.ts,
 * ensuring each tool call resolves the authenticated user from its specific
 * HTTP request context.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedUser } from "../auth/getAuthenticatedUser.js";

import { registerGetCandidateProfile } from "./tools/getCandidateProfile.js";
import { registerGetResume } from "./tools/getResume.js";
import { registerGetPreferences } from "./tools/getPreferences.js";
import { registerGetApplicationHistory } from "./tools/getApplicationHistory.js";
import { registerSaveAnswer } from "./tools/saveAnswer.js";

export const MCP_SERVER_NAME = "Job Application Assistant";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * Create a new McpServer with all tools registered.
 *
 * @param getUser - An async thunk that resolves the authenticated user for
 *   the current request. Injected from the HTTP layer so that tools remain
 *   decoupled from HTTP internals.
 */
export function createMcpServer(
  getUser: () => Promise<AuthenticatedUser>
): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  // Register all MCP tools
  registerGetCandidateProfile(server, getUser);
  registerGetResume(server, getUser);
  registerGetPreferences(server, getUser);
  registerGetApplicationHistory(server, getUser);
  registerSaveAnswer(server, getUser);

  return server;
}
