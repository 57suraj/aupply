/**
 * Tool: log_application
 *
 * Records a job the moment something happens to it: applied, skipped, parked,
 * failed, or saved as a lead. Upserts on (platform, external_id).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplicationInput } from "../../domain/schemas.js";
import { logApplication } from "../../services/applications.js";
import { IDEMPOTENT_WRITE, run } from "../toolkit.js";

export function registerLogApplication(server: McpServer): void {
  server.registerTool(
    "log_application",
    {
      title: "Log an application",
      description:
        "Record a job as soon as something happens to it, not at the end of the session. " +
        "Status must be honest: applied = the platform confirmed it; unconfirmed = submitted but not " +
        "verified; failed = it did not go through; skipped = deliberately not applied (put why in " +
        "status_reason); lead = worth the user's own time (e.g. an external site), not applied; " +
        "parked = stopped for the user (CAPTCHA, references); closed = no longer accepting. " +
        "Always pass the platform's external_id when there is one: the same platform + external_id " +
        "updates the existing record instead of creating a duplicate. Include the screening questions " +
        "and the answers you gave (with answer_id when a saved answer was reused).",
      inputSchema: ApplicationInput.shape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args, extra) => run(extra, (userId) => logApplication(userId, args))
  );
}
