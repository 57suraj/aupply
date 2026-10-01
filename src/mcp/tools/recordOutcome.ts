/**
 * Tool: record_outcome
 *
 * Records something that came back for an application (acknowledgement,
 * rejection, interview, offer, request for information) or a note. The
 * application's stage follows automatically.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventInput } from "../../domain/schemas.js";
import { recordEvent } from "../../services/applications.js";
import { WRITE, run } from "../toolkit.js";

export function registerRecordOutcome(server: McpServer): void {
  server.registerTool(
    "record_outcome",
    {
      title: "Record an outcome",
      description:
        "Record a response or event for an application: acknowledged, screening, assessment, " +
        "interview, offer, hired, rejected, withdrawn, ghosted, info_request, message, or note. " +
        "Identify the application by application_id, or platform + external_id, or company_name " +
        "(most recent application at that company). Set action_required when the user must do " +
        "something (reply, take a test, schedule), with action_due_at if there is a deadline. When " +
        "importing from another source, pass its name as source and the item's id as external_ref so " +
        "the same item is never recorded twice. The application's stage updates automatically.",
      inputSchema: EventInput.shape,
      annotations: WRITE,
    },
    async (args, extra) => run(extra, (userId) => recordEvent(userId, args, "claude"))
  );
}
