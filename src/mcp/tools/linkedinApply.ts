/**
 * Tool: linkedin_apply
 *
 * Applies to LinkedIn Easy Apply jobs (ids, links, or the drafted queue): returns the
 * engine and the queue expression. The runner stays on one page, moves between jobs by
 * SPA navigation, and stops by itself at the daily limit or a second rate limit.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplyJobsInput, PostedWithinInput } from "../../domain/schemas.js";
import { asciiJson, h31 } from "../../engines/index.js";
import { engineConfig, loadUserData, rulesOf } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { applyList, blocked } from "../../platforms/jobs.js";
import { activeBlock, linkedinCap, linkedinWithin, markQueueStarted } from "../../services/automation.js";
import { run } from "../toolkit.js";
import { LINKEDIN_TRACKER } from "./linkedinDraft.js";

export function registerLinkedinApply(server: McpServer): void {
  server.registerTool(
    "linkedin_apply",
    {
      title: "Apply on LinkedIn (Easy Apply)",
      description:
        "Apply to LinkedIn Easy Apply jobs: pass job ids or links, or from_queue for the drafted queue. Returns the " +
        "id of the apply engine for the tracker page (load_engine brings it into the page; see load_rule) and the queue " +
        "call as a code block. Trims the list to today's remaining quota " +
        "(about 35 a day) and drops jobs already applied to. About 2 minutes per job. Poll with " +
        "await __aupply.wait(35000) and send results to report_results every 5 jobs and at the end.",
      inputSchema: {
        ...ApplyJobsInput,
        posted_within: PostedWithinInput,
        keep_open: z.boolean().optional().describe("One job, leaving the form open for a real-click handoff (NEEDS_CLICK, FOLLOW_STUCK)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        const block = await activeBlock(userId, ["linkedin"]);
        if (block) return blocked(block);
        const d = await loadUserData(userId);
        const cap = await linkedinCap(userId, rulesOf(d.prefs));
        if (cap.left <= 0) return { skip: true, reason: `Today's LinkedIn quota is used (${cap.used} of ${cap.cap}).`, next: "Stop LinkedIn for today." };
        const within = await linkedinWithin(userId, args.posted_within);
        const { list, dropped } = await applyList(userId, "linkedin", args, args.keep_open ? 1 : cap.left, within);
        if (!list.length) {
          return {
            nothing_to_apply: true,
            dropped,
            next: args.from_queue ? `No queued job was posted within ${within}: run linkedin_draft first.` : "No job left to apply to.",
          };
        }
        await markQueueStarted(userId, "linkedin");
        const cfg = engineConfig(d, "linkedin", { only: "answers", overrides: args.answers });
        // The queue travels as its own verbatim block with a checksum: a job id mistyped in
        // transit would apply to the wrong job.
        const pairs = list.map((j) => [j.id, j.co]);
        const runQueue = `__aupply.runQueue(${asciiJson(pairs)},{${args.keep_open ? "keepOpen:true," : ""}k:${h31(JSON.stringify(pairs))}})`;
        return envelope(userId, "linkedin", cfg, {
          cap_left: cap.left,
          ...(args.from_queue ? { posted_within: within } : {}),
          jobs: list.length,
          ...(dropped.length ? { dropped } : {}),
          open: LINKEDIN_TRACKER,
          code: [{ name: "run", code: runQueue }],
          steps: [
            `Open ${LINKEDIN_TRACKER} (stay if already there, for example right after a draft, or in a LinkedIn tab left open from earlier that may still hold the engine).`,
            "Load the engine (load_rule). Right after a draft in this page only the apply parts are missing: load_engine sends just those.",
            "Run the `run` block (the queue) as one JavaScript call, copied exactly. It answers 'started'; CORRUPT_QUEUE means copy it again exactly.",
            "Poll await __aupply.wait(35000). Collect the `new` items; call report_results (platform 'linkedin', engine, results) every 5 results, whenever phase leaves 'applying', and at the end with tracker = the status's tracker.",
            "Follow report_results' next (retries, questions for the user, handoffs, stops).",
          ],
          rules: [
            "Do not navigate this tab or open another tab while the queue runs.",
            "The runner stops itself at LinkedIn's daily limit and after a second rate limit. Do not restart it.",
            "Phase 'stalled' means one job made no progress for 4 minutes: report what you have, tell the user, and do not restart the runner.",
            "Technology questions follow the user's own rule: Yes for their skills and for anything a developer with their stack picks up quickly (a framework, tool, database or cloud: Tailwind for someone who uses Bootstrap); No for a language or platform they have no foothold in (Java, .NET, iOS); industry experience is asked once. This is the user's decision: do not pause or stop the run over these answers.",
            ...(args.keep_open
              ? ["Handoff: when the result is NEEDS_CLICK, click the suggestion under the field named in need (rect is in page pixels; scale by screenshot width / iw); for FOLLOW_STUCK untick Follow with a real click. Then run __aupply.resume('<id>') and poll."]
              : []),
          ],
        });
      })
  );
}
