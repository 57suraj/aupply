/**
 * Tool: end_session
 *
 * Closes the run and returns the numbers for the end-of-session summary, computed from
 * the database: counts per platform and status, and provisional answers used (and which
 * companies saw them).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { endSession } from "../../services/sessions.js";
import { IDEMPOTENT_WRITE, run } from "../toolkit.js";

export function registerEndSession(server: McpServer): void {
  server.registerTool(
    "end_session",
    {
      title: "End the session",
      description:
        "Call last. Closes the run and returns counts per platform and status (from the database, not a tally), the " +
        "provisional answers used and which companies saw them. Then tell the user those counts, what broke, and the " +
        "provisional answers used.",
      inputSchema: {
        run_id: z.string().uuid().describe("From start_session."),
        summary: z.string().max(20000).optional().describe("What happened this session, in a few lines."),
        hurdles: z.string().max(10000).optional().describe("What broke and what it cost."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async (args, extra) => run(extra, (userId) => endSession(userId, args))
  );
}
