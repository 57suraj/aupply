/**
 * MCP Server factory.
 *
 * Creates the McpServer with all tools registered. Transport-agnostic: the
 * HTTP wiring (and bearer auth) lives in src/app.ts. Tools read the caller's
 * identity from the verified token in `extra.authInfo` (see toolkit.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerGetCandidateProfile } from "./tools/getCandidateProfile.js";
import { registerGetResume } from "./tools/getResume.js";
import { registerGetPreferences } from "./tools/getPreferences.js";
import { registerGetApplicationHistory } from "./tools/getApplicationHistory.js";
import { registerGetApplicationStats } from "./tools/getApplicationStats.js";
import { registerFindAnswers } from "./tools/findAnswers.js";
import { registerCheckApplied } from "./tools/checkApplied.js";
import { registerGetPendingActions } from "./tools/getPendingActions.js";
import { registerSaveAnswer } from "./tools/saveAnswer.js";
import { registerLogApplication } from "./tools/logApplication.js";
import { registerRecordOutcome } from "./tools/recordOutcome.js";
import { registerCompleteAction } from "./tools/completeAction.js";
import { registerLogRun } from "./tools/logRun.js";

export const MCP_SERVER_NAME = "Aupply";
export const MCP_SERVER_VERSION = "0.2.0";

/** Sent to the client at initialize; tells Claude how a session should go. */
const INSTRUCTIONS = `Aupply holds the user's job-search data: profile, resumes, preferences, saved answers and every application with its outcomes.

How to run a session:
1. Call get_pending_actions first. Anything waiting on the user (an employer asked for information, an interview to schedule) matters more than new applications; raise it before anything else.
2. Read get_candidate_profile, get_preferences and get_resume. Respect the preferences: skip roles below min_salary, above max_years_required, or matching exclude_keywords / excluded_companies.
3. Call log_run to open a session and pass its id as run_id when logging.
4. Before applying, call check_applied with the batch of job ids (and company names) and drop duplicates.
5. For every screening question call find_answers first and reuse the answer. Never invent a personal fact that is not in Aupply; ask the user. If you must infer something low-stakes, save it with save_answer (it is stored as provisional) and tell the user.
6. Call log_application right after each job is applied to, skipped, parked or failed, with an honest status. Do not batch logging until the end.
7. Record replies, rejections, interviews and offers with record_outcome.
8. End with log_run (summary, stats, ended: true) and report counts per platform to the user.`;

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );

  // Read
  registerGetPendingActions(server);
  registerGetCandidateProfile(server);
  registerGetPreferences(server);
  registerGetResume(server);
  registerFindAnswers(server);
  registerCheckApplied(server);
  registerGetApplicationHistory(server);
  registerGetApplicationStats(server);

  // Write
  registerLogRun(server);
  registerLogApplication(server);
  registerSaveAnswer(server);
  registerRecordOutcome(server);
  registerCompleteAction(server);

  return server;
}
