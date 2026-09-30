/**
 * Tool: get_candidate_profile
 *
 * Identity, contact details, work history, education and the user's canonical
 * facts (keyed answers such as notice period or sponsorship).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCandidateProfile } from "../../services/candidate.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerGetCandidateProfile(server: McpServer): void {
  server.registerTool(
    "get_candidate_profile",
    {
      title: "Get candidate profile",
      description:
        "Get the user's candidate profile: identity, contact details, current role and pay, " +
        "notice period, skills, work history, education, and canonical facts (keyed saved " +
        "answers such as sponsorship or relocation). Call this before filling any application. " +
        "If a fact a form needs is missing, do not invent it: ask the user, then save_answer.",
      annotations: READ_ONLY,
    },
    async (extra) => run(extra, (userId) => getCandidateProfile(userId))
  );
}
