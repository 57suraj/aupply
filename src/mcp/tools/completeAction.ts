/**
 * Tool: complete_action
 *
 * Marks a pending action (from get_pending_actions) as done.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateEvent } from "../../services/applications.js";
import { IDEMPOTENT_WRITE, run } from "../toolkit.js";

export function registerCompleteAction(server: McpServer): void {
  server.registerTool(
    "complete_action",
    {
      title: "Complete an action",
      description:
        "Mark a pending action as done once the user has handled it (replied, took the test, " +
        "scheduled the interview). Use the event id from get_pending_actions.",
      inputSchema: {
        event_id: z.string().uuid(),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ event_id }, extra) =>
      run(extra, (userId) => updateEvent(userId, event_id, { action_done: true }))
  );
}
