/**
 * Tool: get_preferences
 *
 * The user's job-search criteria: target roles, locations, pay floor,
 * experience cap, stacks and companies to skip, channels and limits.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPreferences } from "../../services/candidate.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerGetPreferences(server: McpServer): void {
  server.registerTool(
    "get_preferences",
    {
      title: "Get job preferences",
      description:
        "Get the user's job-search preferences: desired roles and seniority, locations and work " +
        "modes, min_salary (skip anything below it) and expected_salary (state it when asked), " +
        "max_years_required (skip postings that ask for more), keywords and companies to include " +
        "or exclude, enabled platforms, max posting age, daily application limit, and free-form " +
        "notes. Use these to filter jobs before applying.",
      annotations: READ_ONLY,
    },
    async (extra) => run(extra, (userId) => getPreferences(userId))
  );
}
