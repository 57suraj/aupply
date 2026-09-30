/**
 * Tool: get_application_history
 *
 * Retrieves the authenticated user's job application history, including
 * companies applied to, job titles, application status, and timestamps.
 *
 * TODO (Phase 2): Query the `application_history` table scoped to `user_id = user.id`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedUser } from "../../auth/getAuthenticatedUser.js";

export function registerGetApplicationHistory(
  server: McpServer,
  _getUser: () => Promise<AuthenticatedUser>
): void {
  server.tool(
    "get_application_history",
    "Retrieve the authenticated user's job application history, including companies applied to, job titles, current status, and application dates.",
    {},
    async () => {
      // TODO (Phase 2): Uncomment and implement:
      // const user = await getUser();
      // const { data, error } = await supabase
      //   .from("application_history")
      //   .select("*")
      //   .eq("user_id", user.id)
      //   .order("applied_at", { ascending: false });
      // if (error) throw error;
      // return { content: [{ type: "text", text: JSON.stringify(data) }] };

      return {
        content: [
          {
            type: "text",
            text: "Not implemented yet. get_application_history will return the user's application history in Phase 2.",
          },
        ],
      };
    }
  );
}
