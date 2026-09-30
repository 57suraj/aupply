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
import { registerResolveAnswers } from "./tools/resolveAnswers.js";
import { registerCheckApplied } from "./tools/checkApplied.js";
import { registerGetPendingActions } from "./tools/getPendingActions.js";
import { registerSaveAnswer } from "./tools/saveAnswer.js";
import { registerUpdateProfile } from "./tools/updateProfile.js";
import { registerLogApplication } from "./tools/logApplication.js";
import { registerRecordOutcome } from "./tools/recordOutcome.js";
import { registerCompleteAction } from "./tools/completeAction.js";
import { registerStartSession } from "./tools/startSession.js";
import { registerEndSession } from "./tools/endSession.js";
import { registerQueueJobs } from "./tools/queueJobs.js";
import { registerReportResults } from "./tools/reportResults.js";
import { registerLinkedinDraft } from "./tools/linkedinDraft.js";
import { registerLinkedinApply } from "./tools/linkedinApply.js";
import { registerNaukriDraft } from "./tools/naukriDraft.js";
import { registerNaukriApply } from "./tools/naukriApply.js";
import { registerNaukriRefreshProfile } from "./tools/naukriRefreshProfile.js";
import { registerWellfoundDraft } from "./tools/wellfoundDraft.js";
import { registerWellfoundApply } from "./tools/wellfoundApply.js";
import { registerIndeedDraft } from "./tools/indeedDraft.js";
import { registerIndeedApply } from "./tools/indeedApply.js";

export const MCP_SERVER_NAME = "Aupply";
export const MCP_SERVER_VERSION = "0.4.0";

/** Sent to the client at initialize; tells Claude how a session should go. */
const INSTRUCTIONS = `Aupply holds the user's job-search data and the scripts that apply to jobs for them on LinkedIn (Easy Apply), Naukri, Wellfound and Indeed. The scripts run in the user's own browser through your browser tool; Aupply never contacts job sites itself.

A session:
1. Call start_session first. If it returns setup_needed, read get_resume, propose values for those fields, ask the user about anything the resume doesn't say, and save what they confirm with update_profile before drafting. Raise its pending_actions with the user before applying to anything new, run its inbox_queries if you have a mail tool (record hits with record_outcome), and reconcile what it lists.
2. Per platform: <platform>_draft, then follow its steps exactly: paste inject as the browser tool's source (never eval it), run the expressions given, poll with __aupply.wait. queue_jobs stores the draft; if it returns ask_user, ask the user once, in one message, and pass the answers back as decisions.
3. <platform>_apply with from_queue (or the ids or links the user gave). Follow its steps and send results to report_results every 5 jobs and at the end, then follow report_results' next: retries, questions for the user, real-click handoffs, stops.
4. Rate limits come first. Never shorten a wait, restart a stopped script, or open a second tab while one runs. When a tool reports blocked, leave that platform until the time it gives.
5. For a question a script could not answer, or a form you fill by hand, call resolve_answers. Never invent a personal fact: ask the user what stays unknown or protected and save it with save_answer. Never touch a CAPTCHA; Indeed applications are parked for the user to submit.
6. A script's verdict is not proof; report the platform's own counts when asked. End with end_session and tell the user its counts per platform, what broke, an honest read of the funnel, and the provisional answers used.
If you cannot control a browser, say so. You can still record outcomes from the user's inbox with record_outcome and check what they have applied to.`;

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
  registerResolveAnswers(server);
  registerCheckApplied(server);
  registerGetApplicationHistory(server);
  registerGetApplicationStats(server);

  // Write
  registerStartSession(server);
  registerEndSession(server);
  registerLogApplication(server);
  registerSaveAnswer(server);
  registerUpdateProfile(server);
  registerRecordOutcome(server);
  registerCompleteAction(server);

  // Automation: draft a queue, apply, report
  registerQueueJobs(server);
  registerReportResults(server);
  registerLinkedinDraft(server);
  registerLinkedinApply(server);
  registerNaukriDraft(server);
  registerNaukriApply(server);
  registerNaukriRefreshProfile(server);
  registerWellfoundDraft(server);
  registerWellfoundApply(server);
  registerIndeedDraft(server);
  registerIndeedApply(server);

  return server;
}
