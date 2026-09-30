/**
 * Tool: get_candidate_profile
 *
 * Retrieves the authenticated user's candidate profile, including personal
 * information and contact details stored in the application.
 *
 * TODO (Phase 2): Query the `users` table scoped to `user.id` and return
 * the full candidate profile object.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedUser } from "../../auth/getAuthenticatedUser.js";

export function registerGetCandidateProfile(
  server: McpServer,
  _getUser: () => Promise<AuthenticatedUser>
): void {
  server.tool(
    "get_candidate_profile",
    "Retrieve the authenticated user's candidate profile, including their name, contact information, and account details.",
    {},
    async () => {
      // TODO (Phase 2): Uncomment and implement:
      // const user = await getUser();
      // const { data, error } = await supabase
      //   .from("users")
      //   .select("*")
      //   .eq("id", user.id)
      //   .single();
      // if (error) throw error;
      // return { content: [{ type: "text", text: JSON.stringify(data) }] };

      return {
        content: [
          {
            type: "text",
            text: "Not implemented yet. get_candidate_profile will return the authenticated user's profile in Phase 2.",
          },
        ],
      };
    }
  );
}
