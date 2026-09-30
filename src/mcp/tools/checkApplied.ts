/**
 * Tool: check_applied
 *
 * Cheap dedup before spending anything on a job: one lookup on the unique index for a
 * batch of ids (any form: ids, links, URNs), plus companies already touched.
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
        "Before any costly step on a batch of jobs, check which ones Aupply already knows for this user (applied, " +
        "skipped, queued, closed). Pass the platform and its job ids or links; ids are normalised, so a link and a " +
        "bare id match. Returns new (never seen) and known ([id, status] pairs), plus companies already touched " +
        "(matched case-insensitively across platforms). In a LinkedIn draft, pass the known ids to prescreen as skip.",
      inputSchema: {
        platform: z.string().optional().describe("e.g. linkedin. Omit to match job ids on any platform."),
        external_ids: z.array(z.string().max(500)).max(500).optional().describe("The platform's job ids or links."),
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
