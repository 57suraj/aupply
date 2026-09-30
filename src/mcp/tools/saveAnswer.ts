/**
 * Tool: save_answer
 *
 * Saves an answer to a job application question so it can be reused
 * across future applications.
 *
 * TODO (Phase 2): Insert into the `answers` table scoped to `user_id = user.id`.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedUser } from "../../auth/getAuthenticatedUser.js";

const SaveAnswerSchema = {
  question: z.string().describe("The application question that was answered."),
  answer: z.string().describe("The answer provided for the question."),
};

export function registerSaveAnswer(
  server: McpServer,
  _getUser: () => Promise<AuthenticatedUser>
): void {
  server.tool(
    "save_answer",
    "Save an answer to a job application question for future reuse.",
    SaveAnswerSchema,
    async (_args) => {
      // TODO (Phase 2): Uncomment and implement:
      // const user = await getUser();
      // const { error } = await supabase
      //   .from("answers")
      //   .insert({
      //     user_id: user.id,
      //     question: args.question,
      //     answer: args.answer,
      //   });
      // if (error) throw error;
      // return { content: [{ type: "text", text: "Answer saved successfully." }] };

      return {
        content: [
          {
            type: "text",
            text: "Not implemented yet. save_answer will persist the answer to the database in Phase 2.",
          },
        ],
      };
    }
  );
}
