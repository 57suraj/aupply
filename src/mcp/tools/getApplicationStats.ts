/**
 * Tool: get_application_stats
 *
 * Funnel numbers: totals by status, platform and stage, submissions today /
 * 7d / 30d, how many got any response, and open actions.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStats } from "../../services/applications.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerGetApplicationStats(server: McpServer): void {
  server.registerTool(
    "get_application_stats",
    {
      title: "Get application stats",
      description:
        "Get funnel statistics: totals by status, submissions by platform and stage, submissions " +
        "today (in the user's time zone), in the last 7 and 30 days, how many received any " +
        "response, and how many actions are waiting on the user. Use it to respect daily limits " +
        "and for end-of-session summaries.",
      annotations: READ_ONLY,
    },
    async (extra) => run(extra, (userId) => getStats(userId))
  );
}
