/**
 * Tool: wellfound_apply
 *
 * Applies to Wellfound jobs (links, or the drafted queue): opens the modal, answers the
 * screening form, adds the cover note, clears a soft location block and sends. Skips a
 * company already applied to before clicking anything.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplyJobsInput } from "../../domain/schemas.js";
import { engineConfig, loadUserData } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { applyList, blocked } from "../../platforms/jobs.js";
import { activeBlock, appliedCompanies } from "../../services/automation.js";
import { run } from "../toolkit.js";

export function registerWellfoundApply(server: McpServer): void {
  server.registerTool(
    "wellfound_apply",
    {
      title: "Apply on Wellfound",
      description:
        "Apply to Wellfound jobs: pass job links (wellfound.com/jobs/<id>-<slug>) or from_queue for the drafted " +
        "queue. Returns the script and per-job steps. Answers the screening form, adds the user's cover note, never " +
        "sends with a question unanswered, and skips companies already applied to. Report results to report_results " +
        "every 5 jobs and at the end.",
      inputSchema: {
        ...ApplyJobsInput,
        cover_note: z.string().max(5000).optional().describe("Overrides the user's saved cover_note answer."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        const block = await activeBlock(userId, ["wellfound"]);
        if (block) return blocked(block);
        const { list, dropped } = await applyList(userId, "wellfound", args, 20);
        if (!list.length) return { nothing_to_apply: true, dropped, next: args.from_queue ? "The queue is empty: run wellfound_draft first." : "No job left to apply to." };
        const cfg = engineConfig(await loadUserData(userId), "wellfound", {
          overrides: args.answers,
          known: await appliedCompanies(userId, "wellfound"),
          coverNote: args.cover_note ?? null,
        });
        return envelope(userId, "wellfound", cfg, {
          jobs: list.map((j) => ({ id: j.id, url: j.url })),
          ...(dropped.length ? { dropped } : {}),
          steps: [
            "For each job in order: navigate to its url, then load the engine (load_rule; after the first page loaded_check re-loads it from the page's cache).",
            "Run __aupply.apply('<id>'), then await __aupply.wait(35000) until the job's result is in `new` (the modal can take 30 seconds).",
            "Call report_results (platform 'wellfound', engine, results) every 5 results and at the end, and follow its next.",
          ],
          rules: [
            "If someone else may be using this Chrome window, take a small screenshot between polls: hidden tabs throttle timers and the modal stalls.",
            "Take a screenshot before concluding anything about a missing modal.",
          ],
        });
      })
  );
}
