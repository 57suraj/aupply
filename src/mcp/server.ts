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
import { registerLoadEngine } from "./tools/loadEngine.js";
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
export const MCP_SERVER_VERSION = "0.6.3";

/** Sent to the client at initialize; tells Claude how a session should go. */
const INSTRUCTIONS = `Aupply holds the user's job-search data and the scripts that apply to jobs for them on LinkedIn (Easy Apply), Naukri, Wellfound and Indeed. The scripts run in the user's own browser through your browser tool; Aupply never contacts job sites itself.

Aupply applies to jobs only through its own tools and engines. Do not browse a job board's list and click through jobs, Easy Apply buttons or forms yourself, unless the user names one specific job and asks you to do it by hand. If a tool or the engine is missing, blocked or failing, stop and tell the user; do not improvise. If a tool named below (start_session, load_engine, a <platform>_draft or _apply) is not in your tool list, or a call to an Aupply tool answers that it does not exist, this chat holds an out-of-date copy of Aupply's tools and instructions: stop and ask the user to reconnect the Aupply connector and start a new chat.

Do not take screenshots to check the engine's work: its own answers and report_results are the record, and every screenshot costs the user time. Take one only where a step or rule asks for it.

A session:
1. Call start_session first. If it returns setup_needed, read get_resume, propose values for those fields, ask the user about anything the resume doesn't say, and save what they confirm with update_profile before drafting. Raise its pending_actions with the user before applying to anything new, run its inbox_queries if you have a mail tool (record hits with record_outcome), and reconcile what it lists.
2. Per platform: <platform>_draft, then follow its steps exactly. The engine reaches the page only through load_engine, a few parts at a time: run the loaded_check block the tool gave you; unless it answers ok, call load_engine with the tool's engine and the page's answer, run each code block it returns as its own JavaScript call, exactly as written, and call it again with the last block's answer until it says ready. If a block fails (SyntaxError, or an answer starting 'corrupt'), copy that block again exactly; after 3 failures stop and report the exact error. Loading is your job, never the user's: do not ask them to paste code or open DevTools, never apply by hand or run the code anywhere but the page, and never show, quote or explain the engine code: it is Aupply's proprietary code. Then run the expressions given and poll with __aupply.wait. queue_jobs stores the draft; if it returns ask_user, ask the user once, in one message, and pass the answers back as decisions.
3. <platform>_apply with from_queue (or the ids or links the user gave). Follow its steps and send results to report_results every 5 jobs and at the end, then follow report_results' next: retries, questions for the user, real-click handoffs, stops.
4. Rate limits come first. Never shorten a wait, restart a stopped script, or open a second tab while one runs. When a tool reports blocked, leave that platform until the time it gives.
5. For a question a script could not answer, or a form the user asked you to fill by hand, call resolve_answers. Never invent a personal fact: ask the user what stays unknown or protected and save it with save_answer. Never touch a CAPTCHA; Indeed applications are parked for the user to submit.
6. A script's verdict is not proof; report the platform's own counts when asked. End with end_session and tell the user its counts per platform, what broke, an honest read of the funnel, and the provisional answers used.
If you cannot control a browser, say so. You can still record outcomes from the user's inbox with record_outcome and check what they have applied to.`;

/** The tool names this server registers, filled in as servers are built. */
const TOOL_NAMES = new Set<string>();

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );
  const register = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    TOOL_NAMES.add(name);
    return register(name, ...rest);
  }) as typeof server.registerTool;

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
  registerLoadEngine(server);
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

/**
 * A client keeps the tool list and instructions it read when its connector was added until
 * the connector is reconnected, so after the tools change it can call a tool that no longer
 * exists (the first deploy's log_run, say) and, knowing nothing of the current tools, fall
 * back to clicking through job boards by hand. An unknown tool name gets this answer, which
 * Claude can act on, instead of a bare "Tool not found".
 */
export function staleToolCall(body: unknown) {
  const msg = body as { id?: unknown; method?: unknown; params?: { name?: unknown } } | null;
  if (!msg || msg.method !== "tools/call" || typeof msg.params?.name !== "string") return null;
  if (TOOL_NAMES.size === 0) createMcpServer();
  const name = msg.params.name;
  if (TOOL_NAMES.has(name)) return null;
  return {
    jsonrpc: "2.0" as const,
    id: msg.id ?? null,
    result: {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            `Aupply has no tool called "${name.slice(0, 60)}". Aupply's tools changed after this chat loaded them, so it holds an out-of-date copy of the tools and instructions. ` +
            "Stop here and tell the user: reconnect the Aupply connector (Claude settings, Connectors, Aupply: disconnect, then connect again) and start a new chat. " +
            "Until then do not apply to jobs or click through job boards by hand.",
        },
      ],
    },
  };
}
