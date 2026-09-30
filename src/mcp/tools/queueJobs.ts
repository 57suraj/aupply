/**
 * Tool: queue_jobs
 *
 * Stores a draft: kept jobs become the queue (status discovered), dropped jobs are
 * recorded as skipped so no later draft screens them again. Jobs whose JD names a
 * technology the user does not list come back in ask_user for one batch decision.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QueueJobsInput } from "../../domain/schemas.js";
import { queueJobs } from "../../services/automation.js";
import { IDEMPOTENT_WRITE, run } from "../toolkit.js";

export function registerQueueJobs(server: McpServer): void {
  server.registerTool(
    "queue_jobs",
    {
      title: "Queue drafted jobs",
      description:
        "Store the output of a draft script (or jobs found elsewhere: Indeed connector, alert emails, links): kept " +
        "jobs join the platform's queue, dropped jobs are recorded as skipped. Pass the script's output as-is. Jobs " +
        "already known are ignored. Returns the queue, and ask_user when some jobs want a technology the user does " +
        "not list: ask the user once, in one message, and pass their answers back as decisions.",
      inputSchema: QueueJobsInput.shape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args, extra) => run(extra, (userId) => queueJobs(userId, QueueJobsInput.parse(args)))
  );
}
