/**
 * Tool: log_run
 *
 * Opens and closes an application session so throughput is tracked over time.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RunInput } from "../../domain/schemas.js";
import { logRun } from "../../services/runs.js";
import { WRITE, run } from "../toolkit.js";

export function registerLogRun(server: McpServer): void {
  server.registerTool(
    "log_run",
    {
      title: "Log a session",
      description:
        "Track an application session. Call without run_id at the start to open one (returns its id; " +
        "pass it as run_id to log_application). Call again with run_id, a short summary, stats " +
        "(e.g. counts per platform) and ended: true at the end of the session.",
      inputSchema: RunInput.shape,
      annotations: WRITE,
    },
    async (args, extra) => run(extra, (userId) => logRun(userId, args))
  );
}
