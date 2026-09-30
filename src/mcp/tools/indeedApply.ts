/**
 * Tool: indeed_apply
 *
 * Prepares Indeed applications up to the review page and parks them: the review page
 * carries a reCAPTCHA that only the user may tick. Each job gets its own tab, left open.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplyJobsInput } from "../../domain/schemas.js";
import { engineConfig, loadUserData } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { applyList, blocked } from "../../platforms/jobs.js";
import { activeBlock } from "../../services/automation.js";
import { run } from "../toolkit.js";

export function registerIndeedApply(server: McpServer): void {
  server.registerTool(
    "indeed_apply",
    {
      title: "Prepare Indeed applications",
      description:
        "Prepare Indeed 'Easily apply' applications: pass jks or links, or from_queue. Fills the wizard up to the " +
        "review page and stops there, because a reCAPTCHA gates Submit and only the user may tick it. Each job is " +
        "left open in its own tab (status parked); give the user one list of the tabs at the end. Never touch the " +
        "CAPTCHA and never close a parked tab.",
      inputSchema: ApplyJobsInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        const block = await activeBlock(userId, ["indeed"]);
        if (block) return blocked(block);
        const { list, dropped } = await applyList(userId, "indeed", args, 10);
        if (!list.length) return { nothing_to_apply: true, dropped, next: args.from_queue ? "The queue is empty: run indeed_draft first." : "No job left to prepare." };
        const cfg = engineConfig(await loadUserData(userId), "indeed", { overrides: args.answers });
        return envelope("indeed", cfg, {
          engineLoaded: args.engine_loaded,
          jobs: list.map((j) => ({ id: j.id, url: j.url })),
          ...(dropped.length ? { dropped } : {}),
          steps: [
            "For each job, in a NEW tab: open its url, load the engine (paste_rule), then run await __aupply.drive('<jk>'). Expect NAVIGATED: the tab moves to smartapply.indeed.com.",
            "In that same tab (now smartapply) load the engine again (paste_rule: smartapply is its own origin, so the first time there loaded_check lists parts), then await __aupply.drive('<jk>') until r is READY_FOR_CAPTCHA. r = CONTINUE: call drive again.",
            "Call report_results (platform 'indeed', engine, results) with each final result. Leave every parked tab open.",
            "At the end, tell the user in one message how many tabs are waiting and which company and role each holds.",
          ],
          rules: [
            "Never click, solve or work around the reCAPTCHA. Never close a tab parked on the review page.",
            "NEEDS_DROPDOWN is a combobox: click the box, type the value, click the matching option with real clicks, then call drive again.",
          ],
        });
      })
  );
}
