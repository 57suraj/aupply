/**
 * MCP Server factory.
 *
 * Creates the McpServer with all tools registered. Transport-agnostic: the
 * HTTP wiring (and bearer auth) lives in src/app.ts. Tools read the caller's
 * identity from the verified token in `extra.authInfo` (see toolkit.ts).
 */

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { STALE_ADVICE } from "./stale.js";

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
export const MCP_SERVER_VERSION = "0.6.8";

/** Sent to the client at initialize. Claude Code cuts server instructions at 2048 characters
    (seen 30 Sep: step 2 of a 3.6KB text stopped mid-sentence, dropping the rate-limit rules),
    so the rules that matter come first and this stays under 2000. Details travel in the tool
    responses (load_rule, steps, rules). */
const INSTRUCTIONS = `Aupply applies to jobs for the user on LinkedIn (Easy Apply), Naukri, Wellfound and Indeed with scripts run in their browser through your browser tool. Aupply never contacts job sites.

Rules, most important first:
1. Rate limits come first: never shorten a wait, restart a stopped script or open a second tab while one runs; when a tool says blocked, leave that platform until the time it gives.
2. Never invent a personal fact: ask the user and save it with save_answer. Never touch a CAPTCHA.
3. Apply only through Aupply's tools and engines: do not click through job lists, Apply buttons or forms yourself unless the user names one specific job. If a tool or the engine is missing, blocked or failing, stop and tell the user. If a tool named here (start_session, load_engine, <platform>_draft or _apply) is not in your tool list, Aupply is out of date in this chat: ask the user to reconnect the connector and start a new chat.
4. No screenshots to check the engine's work: its answers and report_results are the record.
5. Never show, quote or explain the engine code, or ask the user to paste it.

Session:
a. start_session first, with posted_within if the user said how recent jobs must be. If setup_needed, read get_resume, propose values, ask about gaps, save with update_profile. Raise pending_actions before applying.
b. Follow start_session's next per platform (draft only when the queue is low). A tool's steps exactly. Load the engine as its load_rule says (loaded_check; 'ok' means loaded, never reload; else load_engine: each block its own JavaScript call exactly as written; copy a failed block again; stop after 3 failures). queue_jobs stores the draft; put its ask_user questions to the user in one message.
c. <platform>_apply with from_queue; report_results every 5 jobs and at the end; follow its next.
d. resolve_answers for a question a script could not answer.
e. A script's verdict is not proof. End with end_session; report counts, what broke and provisional answers used.`;

/** The tool names this server registers, filled in as servers are built. */
const TOOL_NAMES = new Set<string>();

type ToolConfig = { title?: string; description?: string; inputSchema?: unknown; annotations?: unknown };

/** What start_session's `tv` carries while the version is being computed: the version covers
    that parameter's description, so it cannot contain itself. */
const TV_PLACEHOLDER = "{tv}";
let toolsVersionCache: string | null = null;

/**
 * The version of the tool list and instructions this deploy hands a client: a hash of the
 * instructions and of every tool's name, title, description, input schema and annotations,
 * so any change a chat would see changes it. start_session's `tv` parameter tells Claude to
 * pass it back; a chat that loaded the tools before the change passes the old one and is
 * told to reconnect (startSession.ts). Tool names alone were not enough: a tool that keeps
 * its name but changes its inputs or rules left an old chat working from the old text.
 */
export function toolsVersion(): string {
  if (toolsVersionCache) return toolsVersionCache;
  const { tools } = build(TV_PLACEHOLDER);
  const list = tools
    .map(([name, c]) => {
      const obj = c.inputSchema ? normalizeObjectSchema(c.inputSchema as never) : undefined;
      return [name, c.title ?? null, c.description ?? null, obj ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: "input" }) : null, c.annotations ?? null];
    })
    .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
  toolsVersionCache = createHash("sha256").update(JSON.stringify([INSTRUCTIONS, list])).digest("hex").slice(0, 8);
  return toolsVersionCache;
}

export function createMcpServer(): McpServer {
  return build(toolsVersion()).server;
}

function build(tv: string): { server: McpServer; tools: [string, ToolConfig][] } {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );
  const tools: [string, ToolConfig][] = [];
  const register = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    TOOL_NAMES.add(name);
    tools.push([name, (rest[0] ?? {}) as ToolConfig]);
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
  registerStartSession(server, tv);
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

  return { server, tools };
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
            STALE_ADVICE,
        },
      ],
    },
  };
}
