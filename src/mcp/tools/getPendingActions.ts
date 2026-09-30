/**
 * Tool: get_pending_actions
 *
 * Everything waiting on the user: info requests, assessments, interviews to
 * schedule. Worth more than any number of new applications.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listPendingActions } from "../../services/applications.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerGetPendingActions(server: McpServer): void {
  server.registerTool(
    "get_pending_actions",
    {
      title: "Get pending actions",
      description:
        "List outcomes that need the user to act (an employer asked for information, an assessment, " +
        "an interview to schedule, a failed submission to redo), soonest due first. Call this at the " +
        "start of every session and raise them with the user before applying to anything new. " +
        "Mark one done with complete_action.",
      annotations: READ_ONLY,
    },
    async (extra) => run(extra, (userId) => listPendingActions(userId))
  );
}
