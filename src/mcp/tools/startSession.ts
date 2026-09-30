/**
 * Tool: start_session
 *
 * Opens a run and returns, in one call, everything to handle before applying: what
 * waits on the user, parked and unconfirmed jobs to reconcile, the inbox searches, and
 * each platform's state (queue, LinkedIn quota, Naukri refresh, backoffs).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startSession } from "../../services/sessions.js";
import { WRITE, run } from "../toolkit.js";

export function registerStartSession(server: McpServer): void {
  server.registerTool(
    "start_session",
    {
      title: "Start a session",
      description:
        "Call first in every job-search session. Opens a run and returns: pending_actions (things waiting on the " +
        "user; raise them before applying to anything new), reconcile (parked and unconfirmed jobs and how to confirm " +
        "each), inbox_queries (mail searches and what a hit means), each platform's state (queued jobs, LinkedIn " +
        "quota left, Naukri refresh due, rate-limit backoffs), provisional answers to confirm with the user, and a " +
        "warning if another session looks live.",
      inputSchema: {
        client: z.string().max(50).optional().describe("e.g. claude_ai, claude_code."),
        platforms: z.array(z.string().max(30)).max(10).optional().describe("Platforms for this session. Default: the user's enabled platforms."),
      },
      annotations: WRITE,
    },
    async (args, extra) => run(extra, (userId) => startSession(userId, args))
  );
}
