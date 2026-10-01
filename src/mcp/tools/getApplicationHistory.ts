/**
 * Tool: get_application_history
 *
 * Filtered, paginated list of jobs the user has touched (applied, skipped,
 * leads, ...), newest first. Job descriptions are omitted to keep it small.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APPLICATION_STAGES, APPLICATION_STATUSES } from "../../domain/schemas.js";
import { listApplications } from "../../services/applications.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerGetApplicationHistory(server: McpServer): void {
  server.registerTool(
    "get_application_history",
    {
      title: "Get application history",
      description:
        "List jobs the user has already touched, newest first. status is what was done " +
        "(applied, unconfirmed, skipped, lead, parked, failed, closed, discovered); stage is what " +
        "the employer did (acknowledged, interview, offer, rejected, ...). To check specific jobs " +
        "before applying, prefer check_applied.",
      inputSchema: {
        status: z.array(z.enum(APPLICATION_STATUSES)).optional(),
        stage: z.array(z.enum(APPLICATION_STAGES)).optional(),
        platform: z.string().optional().describe("e.g. linkedin, wellfound, naukri, indeed"),
        search: z.string().max(200).optional().describe("Matches company name or job title."),
        since: z.string().datetime({ offset: true }).optional().describe("ISO timestamp; only records created after it."),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ_ONLY,
    },
    async ({ status, stage, platform, search, since, limit, offset }, extra) =>
      run(extra, (userId) =>
        listApplications(userId, {
          status,
          stage,
          platform: platform?.toLowerCase(),
          q: search,
          since,
          limit,
          offset,
          sort: "created",
        })
      )
  );
}
