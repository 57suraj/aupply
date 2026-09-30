/**
 * Tool: check_applied
 *
 * Cheap dedup before spending effort on a job: which job ids and companies
 * the user has already touched, with their status.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../../lib/errors.js";
import { checkExisting } from "../../services/applications.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerCheckApplied(server: McpServer): void {
  server.registerTool(
    "check_applied",
    {
      title: "Check for duplicates",
      description:
        "Before applying, check a batch of jobs against everything already recorded. Pass the " +
        "platform and its job ids, and/or company names (matched case-insensitively across all " +
        "platforms). Returns the jobs and companies already known, with status. Skip jobs already " +
        "applied to or skipped; think twice about companies that already have an application.",
      inputSchema: {
        platform: z.string().optional().describe("e.g. linkedin. Omit to match job ids on any platform."),
        external_ids: z.array(z.string().max(200)).max(500).optional().describe("The platform's own job ids."),
        companies: z.array(z.string().max(300)).max(200).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ platform, external_ids, companies }, extra) =>
      run(extra, async (userId) => {
        if (!external_ids?.length && !companies?.length) {
          throw new AppError("Pass external_ids and/or companies.");
        }
        return checkExisting(userId, { platform: platform?.toLowerCase(), external_ids, companies });
      })
  );
}
