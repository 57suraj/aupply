/**
 * Tool: start_session
 *
 * Opens a run and returns, in one call, everything to handle before applying: what
 * waits on the user, parked and unconfirmed jobs to reconcile, and each platform's state (queue, LinkedIn quota, Naukri refresh, backoffs).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { POSTED_WITHIN } from "../../domain/schemas.js";
import { AppError } from "../../lib/errors.js";
import { startSession } from "../../services/sessions.js";
import { STALE_ADVICE } from "../stale.js";
import { WRITE, run } from "../toolkit.js";

/** tv: this deploy's tools version (toolsVersion in server.ts), written into the `tv` parameter's
    description. A chat that read the tools before a change passes the old one back. */
export function registerStartSession(server: McpServer, tv: string): void {
  server.registerTool(
    "start_session",
    {
      title: "Start a session",
      description:
        "Call first in every job-search session. Opens a run and returns: pending_actions (things waiting on the " +
        "user; raise them before applying to anything new), reconcile (parked and unconfirmed jobs and how to confirm " +
        "each), each platform's state (queued jobs, LinkedIn " +
        "quota left, Naukri refresh due, rate-limit backoffs), provisional answers to confirm with the user, and a " +
        "warning if another session looks live.",
      inputSchema: {
        client: z.string().max(50).optional().describe("e.g. claude_ai, claude_code."),
        platforms: z.array(z.string().max(30)).max(10).optional().describe("Platforms for this session. Default: the user's enabled platforms."),
        posted_within: z
          .enum(POSTED_WITHIN)
          .optional()
          .describe(
            "LinkedIn: how recent the jobs should be, as the user said at the start: last hour (1h), 24 hours (24h) or week " +
              "(1w). Holds for the whole session: the queue and the draft searches follow it. Default: the user's preference, else 24h."
          ),
        tv: z.string().max(40).optional().describe(`Always pass "${tv}", exactly: the version of Aupply's tools and instructions this chat read.`),
      },
      annotations: WRITE,
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        // No tv (an older chat, or a client that left it out) goes ahead; a different one is a chat
        // that loaded the tools before they changed (30 Sep: it called tools that no longer existed).
        if (args.tv !== undefined && args.tv !== tv) {
          throw new AppError(`This chat holds an out-of-date copy of Aupply's tools and instructions (tv ${args.tv.slice(0, 20)}, current ${tv}), so no session was started. ${STALE_ADVICE}`);
        }
        const { tv: _tv, ...input } = args;
        return startSession(userId, input);
      })
  );
}
