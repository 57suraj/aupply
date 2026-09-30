/**
 * Tool: naukri_apply
 *
 * Applies to Naukri jobs (ids, links, or the drafted queue): one-click or the recruiter
 * chatbot. Naukri submits on click, so there is no review step. The result is the
 * redirect code: 200 applied, 406 nothing created (report_results retries it once).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplyJobsInput } from "../../domain/schemas.js";
import { engineConfig, loadUserData } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { applyList, blocked } from "../../platforms/jobs.js";
import { activeBlock } from "../../services/automation.js";
import { run } from "../toolkit.js";

export function registerNaukriApply(server: McpServer): void {
  server.registerTool(
    "naukri_apply",
    {
      title: "Apply on Naukri",
      description:
        "Apply to Naukri jobs: pass job ids or links, or from_queue for the drafted queue. Returns the script and " +
        "per-job steps. Handles one-click applies and recruiter chatbots, hides the Simplify overlay, unticks " +
        "'Follow company'. The script waits 15 to 30 seconds between applications by itself. Report results to " +
        "report_results every 5 jobs and at the end.",
      inputSchema: ApplyJobsInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        const block = await activeBlock(userId, ["naukri"]);
        if (block) return blocked(block);
        const { list, dropped } = await applyList(userId, "naukri", args, 15);
        if (!list.length) return { nothing_to_apply: true, dropped, next: args.from_queue ? "The queue is empty: run naukri_draft first." : "No job left to apply to." };
        const cfg = engineConfig(await loadUserData(userId), "naukri", { overrides: args.answers });
        return envelope("naukri", cfg, {
          engineLoaded: args.engine_loaded,
          jobs: list.map((j) => ({ id: j.id, url: j.url })),
          ...(dropped.length ? { dropped } : {}),
          steps: [
            "For each job in order: navigate to its url, then load the engine (paste_rule; after the first page loaded_check re-loads it from the page's cache).",
            "Run await __aupply.go('<id>'). r = STARTED: continue below. r = WAIT: wait ms (or work another platform) and run go again. Any other r is already the final result.",
            "After about 20 seconds (the page may have moved to Naukri's result page), run loaded_check again (paste what it lists, if anything) and then await __aupply.finish(35000) until the job's result is in `new`.",
            "Call report_results (platform 'naukri', engine, results) every 5 results and at the end, and follow its next (a first 406 is retried once).",
          ],
          rules: ["One job at a time. Never dismiss the Simplify popup; the script hides it."],
        });
      })
  );
}
