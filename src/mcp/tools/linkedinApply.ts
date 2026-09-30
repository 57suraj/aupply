/**
 * Tool: linkedin_apply
 *
 * Applies to LinkedIn Easy Apply jobs (ids, links, or the drafted queue): returns the
 * engine and the queue expression. The runner stays on one page, moves between jobs by
 * SPA navigation, and stops by itself at the daily limit or a second rate limit.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplyJobsInput } from "../../domain/schemas.js";
import { engineConfig, loadUserData, rulesOf } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { applyList, blocked } from "../../platforms/jobs.js";
import { activeBlock, linkedinCap, markQueueStarted } from "../../services/automation.js";
import { run } from "../toolkit.js";
import { LINKEDIN_TRACKER } from "./linkedinDraft.js";

export function registerLinkedinApply(server: McpServer): void {
  server.registerTool(
    "linkedin_apply",
    {
      title: "Apply on LinkedIn (Easy Apply)",
      description:
        "Apply to LinkedIn Easy Apply jobs: pass job ids or links, or from_queue for the drafted queue. Returns the " +
        "script (~28KB, paste once on the tracker page) and the runner call. Trims the list to today's remaining quota " +
        "(about 35 a day) and drops jobs already applied to. About 2 minutes per job. Poll with " +
        "await __aupply.wait(35000) and send results to report_results every 5 jobs and at the end.",
      inputSchema: {
        ...ApplyJobsInput,
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
        const { list, dropped } = await applyList(userId, "linkedin", args, args.keep_open ? 1 : cap.left);
        if (!list.length) {
          return { nothing_to_apply: true, dropped, next: args.from_queue ? "The queue is empty: run linkedin_draft first." : "No job left to apply to." };
        }
        await markQueueStarted(userId, "linkedin");
        const cfg = engineConfig(d, "linkedin", { overrides: args.answers });
        const queue = JSON.stringify(list.map((j) => [j.id, j.co]));
        return envelope("linkedin", cfg, {
          engineLoaded: args.engine_loaded,
          cap_left: cap.left,
          jobs: list.length,
          ...(dropped.length ? { dropped } : {}),
          open: LINKEDIN_TRACKER,
          steps: [
            `Open ${LINKEDIN_TRACKER} (stay if already there, for example right after a draft).`,
            "If loaded_check is not true on the page, paste inject as the browser tool's source (it's ~28KB and the tool handles it fine). The result will be {ok:true}.",
            `Run __aupply.runQueue(${queue}${args.keep_open ? ", {keepOpen: true}" : ""}).`,
            "Poll await __aupply.wait(35000). Collect the `new` items; call report_results (platform 'linkedin', engine, results) every 5 results, whenever phase leaves 'applying', and at the end with tracker = the status's tracker.",
            "Follow report_results' next (retries, questions for the user, handoffs, stops).",
          ],
          rules: [
            "Do not navigate this tab or open another tab while the queue runs; background timers throttle.",
            "The runner stops itself at LinkedIn's daily limit and after a second rate limit. Do not restart it.",
            ...(args.keep_open
              ? ["Handoff: when the result is NEEDS_CLICK, click the suggestion under the field named in need (rect is in page pixels; scale by screenshot width / iw); for FOLLOW_STUCK untick Follow with a real click. Then run __aupply.resume('<id>') and poll."]
              : []),
          ],
        });
      })
  );
}
