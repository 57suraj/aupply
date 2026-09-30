/**
 * Tool: save_answer
 *
 * Saves an answer to a job application question so it can be reused across
 * future applications. Claude's own answers are provisional unless the user
 * stated them; a confirmed answer is never overwritten by a provisional one.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { saveAnswerFromClaude } from "../../services/answers.js";
import { IDEMPOTENT_WRITE, run } from "../toolkit.js";

export function registerSaveAnswer(server: McpServer): void {
  server.registerTool(
    "save_answer",
    {
      title: "Save an answer",
      description:
        "Save an answer to an application question for reuse. Set confirmed_by_user only when the " +
        "user stated the answer themselves in this conversation; otherwise it is stored as provisional " +
        "for them to confirm later. Use key for canonical facts that many questions map to " +
        "(e.g. notice_period, expected_salary, sponsorship.us, relocation). A confirmed answer is " +
        "never overwritten by a provisional one.",
      inputSchema: {
        question: z.string().min(1).max(2000).describe("The application question that was answered."),
        answer: z.string().min(1).max(20000).describe("The answer provided for the question."),
        key: z
          .string()
          .regex(/^[a-z0-9_.]+$/)
          .optional()
          .describe("Stable slug for a canonical fact, e.g. notice_period."),
        category: z
          .string()
          .max(50)
          .optional()
          .describe("experience, compensation, availability, eligibility, eeo, long_form, other"),
        confirmed_by_user: z.boolean().default(false),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async (args, extra) => run(extra, (userId) => saveAnswerFromClaude(userId, args))
  );
}
