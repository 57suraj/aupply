/**
 * Tool: get_preferences
 *
 * Retrieves the authenticated user's job-search preferences, such as
 * desired roles, locations, salary expectations, and companies to target or avoid.
 *
 * TODO (Phase 2): Query the `preferences` table for `user_id = user.id`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedUser } from "../../auth/getAuthenticatedUser.js";

export function registerGetPreferences(
  server: McpServer,
  _getUser: () => Promise<AuthenticatedUser>
): void {
  server.tool(
    "get_preferences",
    "Retrieve the authenticated user's job-search preferences including desired roles, locations, salary range, and target companies.",
    {},
    async () => {
      // TODO (Phase 2): Uncomment and implement:
      // const user = await getUser();
      // const { data, error } = await supabase
      //   .from("preferences")
      //   .select("*")
      //   .eq("user_id", user.id)
      //   .single();
      // if (error) throw error;
      // return { content: [{ type: "text", text: JSON.stringify(data) }] };

      return {
        content: [
          {
            type: "text",
            text: "Not implemented yet. get_preferences will return the user's job-search preferences in Phase 2.",
          },
        ],
      };
    }
  );
}
