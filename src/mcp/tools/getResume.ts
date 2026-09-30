/**
 * Tool: get_resume
 *
 * Retrieves the authenticated user's most recent active resume content.
 *
 * TODO (Phase 2): Query the `resumes` table for `user_id = user.id`
 * where `is_active = true`. File storage / parsing is deferred to a later phase.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedUser } from "../../auth/getAuthenticatedUser.js";

export function registerGetResume(
  server: McpServer,
  _getUser: () => Promise<AuthenticatedUser>
): void {
  server.tool(
    "get_resume",
    "Retrieve the authenticated user's active resume content for use during job applications.",
    {},
    async () => {
      // TODO (Phase 2): Uncomment and implement:
      // const user = await getUser();
      // const { data, error } = await supabase
      //   .from("resumes")
      //   .select("*")
      //   .eq("user_id", user.id)
      //   .eq("is_active", true)
      //   .order("created_at", { ascending: false })
      //   .limit(1)
      //   .single();
      // if (error) throw error;
      // return { content: [{ type: "text", text: data.content ?? "" }] };

      return {
        content: [
          {
            type: "text",
            text: "Not implemented yet. get_resume will return the user's active resume content in Phase 2.",
          },
        ],
      };
    }
  );
}
