/**
 * Tool: report_results
 *
 * Records what an engine did (the `new` items from status()/wait()) and returns what to
 * do next. Maps each result to a status, applies the retry rules, and turns rate-limit
 * signs into backoffs the platform tools enforce.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReportResultsInput } from "../../domain/schemas.js";
import { reportResults } from "../../services/automation.js";
import { IDEMPOTENT_WRITE, run } from "../toolkit.js";

export function registerReportResults(server: McpServer): void {
  server.registerTool(
    "report_results",
    {
      title: "Report engine results",
      description:
        "Send the results an apply script produced (the `new` items from __aupply.wait()/status(), as-is) every 5 " +
        "jobs and at the end. Records each job's status, logs the answers given, and returns next: jobs to retry " +
        "once, questions to ask the user, real-click handoffs, and rate-limit stops (the platform's tools then " +
        "refuse scripts until the backoff ends). Safe to send the same result twice.",
      inputSchema: ReportResultsInput.shape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args, extra) => run(extra, (userId) => reportResults(userId, ReportResultsInput.parse(args)))
  );
}
