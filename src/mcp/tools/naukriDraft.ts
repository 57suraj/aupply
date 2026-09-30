/**
 * Tool: naukri_draft
 *
 * Builds the Naukri queue: the search result pages to visit (keyword in the URL slug,
 * never ?k=), the engine that scrapes and screens each page, then queue_jobs.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engineConfig, loadUserData } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { blocked, slugify } from "../../platforms/jobs.js";
import { activeBlock } from "../../services/automation.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerNaukriDraft(server: McpServer): void {
  server.registerTool(
    "naukri_draft",
    {
      title: "Draft the Naukri queue",
      description:
        "Build the Naukri queue: returns the search result pages to visit in order and a script that scrapes and " +
        "screens each page (pay floor, seniority, stack, spam and always-external companies, 'Apply on company site' " +
        "id series). Then pass draft() to queue_jobs. Expect 2 to 4 applyable jobs a day.",
      inputSchema: {
        slugs: z.array(z.string().min(2).max(80)).max(6).optional().describe("Search slugs, e.g. node-js-developer. Default: from desired roles."),
        experience: z.array(z.number().int().min(0).max(30)).max(3).optional().describe("Naukri experience filter values. Default: the user's years and one more."),
        job_age_days: z.union([z.literal(1), z.literal(3), z.literal(7)]).optional().describe("Default 1."),
        pages: z.number().int().min(1).max(3).optional().describe("Result pages per search. Default 1."),
        engine_loaded: z.string().max(40).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        const block = await activeBlock(userId, ["naukri"]);
        if (block) return blocked(block);
        const d = await loadUserData(userId);
        const slugs = (args.slugs ?? d.prefs.desired_roles.map(slugify)).filter(Boolean).slice(0, 4);
        if (!slugs.length) return { error: "No search terms: pass slugs or set desired roles in the user's preferences." };
        const y = Math.max(0, Math.round(d.profile.years_experience ?? 1));
        const exps = args.experience ?? [y, y + 1];
        const age = args.job_age_days ?? 1;
        const urls: string[] = [];
        for (const s of slugs) for (const e of exps) for (let p = 1; p <= (args.pages ?? 1); p++) {
          urls.push(`https://www.naukri.com/${s}-jobs-in-india${p > 1 ? `-${p}` : ""}?experience=${e}&jobAge=${age}`);
        }
        const cfg = engineConfig(d, "naukri");
        return envelope("naukri", cfg, {
          engineLoaded: args.engine_loaded,
          pages: urls.slice(0, 16),
          steps: [
            "For each URL in pages, in order: navigate to it, load the engine (paste_rule; after the first page loaded_check re-loads it from the page's cache and answers ok), then run __aupply.scrape(true) on the first page and __aupply.scrape() on the rest.",
            "After the last page run __aupply.draft() and call queue_jobs with platform 'naukri' and jobs = its jobs.",
          ],
          rules: ["One page at a time. Never call Naukri's /jobapi endpoints (they demand a reCAPTCHA)."],
        });
      })
  );
}
