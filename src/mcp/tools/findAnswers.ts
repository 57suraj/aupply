/**
 * Tool: find_answers
 *
 * Fuzzy lookup of a form question against saved answers and answers given on
 * past applications, so the same question gets the same answer every time.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findSimilarAnswers } from "../../services/answers.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerFindAnswers(server: McpServer): void {
  server.registerTool(
    "find_answers",
    {
      title: "Find answers to a question",
      description:
        "Search the user's saved answers and the answers given on past applications for questions " +
        "similar to this one. Call it for every screening question before answering, so answers stay " +
        "consistent. Prefer source 'saved' with status 'confirmed'; 'provisional' answers are guesses " +
        "the user has not confirmed yet.",
      inputSchema: {
        question: z.string().min(2).max(2000).describe("The question as it appears on the form."),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: READ_ONLY,
    },
    async ({ question, limit }, extra) => run(extra, (userId) => findSimilarAnswers(userId, question, limit))
  );
}
