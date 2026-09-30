/**
 * Tool: resolve_answers
 *
 * Answers form questions in a batch, exactly as the browser engines would, falling back
 * to saved answers and past applications. For NEEDS_INPUT results and forms Claude
 * fills by hand.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveAnswers } from "../../services/resolve.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerResolveAnswers(server: McpServer): void {
  server.registerTool(
    "resolve_answers",
    {
      title: "Resolve form answers",
      description:
        "Answer a batch of application-form questions from the user's data, exactly as the apply scripts would " +
        "(same rules, same values), then from saved answers and past applications. Pass the options for a select or " +
        "radio question to get the one to pick. Each result has a status: confirmed (the user's own data), " +
        "provisional (a default or an unconfirmed guess), protected (never invented: ask the user or skip the job), " +
        "or unknown (ask the user, then save_answer).",
      inputSchema: {
        questions: z
          .array(
            z.object({
              q: z.string().min(1).max(2000).describe("The question as the form shows it."),
              options: z.array(z.string().max(500)).max(100).optional(),
              field: z.enum(["text", "number", "select", "radio", "checkbox", "textarea"]).optional(),
              company: z.string().max(300).optional(),
            })
          )
          .min(1)
          .max(50),
        platform: z.string().max(40).optional().describe("Where the job was found; answers 'how did you hear about us'."),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) => run(extra, (userId) => resolveAnswers(userId, args))
  );
}
