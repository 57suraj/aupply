/**
 * Tool: wellfound_draft
 *
 * Builds the Wellfound queue: role listing pages (wellfound.com/role/l/<slug>/<location>,
 * pages 1 and 2) and the engine that reads and screens the cards, then queue_jobs.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engineConfig, loadUserData } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { blocked, slugify } from "../../platforms/jobs.js";
import { WELLFOUND_ROLE_SLUGS } from "../../platforms/knowledge.js";
import { activeBlock } from "../../services/automation.js";
import { READ_ONLY, run } from "../toolkit.js";

const DEFAULT_SLUGS = ["software-engineer", "backend-engineer", "full-stack-engineer"];

export function registerWellfoundDraft(server: McpServer): void {
  server.registerTool(
    "wellfound_draft",
    {
      title: "Draft the Wellfound queue",
      description:
        "Build the Wellfound queue: returns the role listing pages to visit and a script that reads each page's " +
        "cards and screens them (title and URL slug, years, pay band). Then pass draft() to queue_jobs. Job pages " +
        "are client-rendered, so screening happens on the listing pages.",
      inputSchema: {
        role_slugs: z.array(z.string().min(2).max(60)).max(12).optional().describe(`Wellfound role slugs, e.g. ${WELLFOUND_ROLE_SLUGS.slice(0, 4).join(", ")}.`),
        pages: z.number().int().min(1).max(2).optional().describe("Default 2 (page 1 and ?page=2)."),
        location: z.string().max(40).optional().describe("Wellfound location slug. Default india."),
        engine_loaded: z.string().max(40).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        const block = await activeBlock(userId, ["wellfound"]);
        if (block) return blocked(block);
        const d = await loadUserData(userId);
        const mapped = d.prefs.desired_roles.map(slugify).map((s) => s.replace(/node-js/, "nodejs")).filter((s) => WELLFOUND_ROLE_SLUGS.includes(s));
        const slugs = (args.role_slugs ?? (mapped.length ? mapped : DEFAULT_SLUGS)).slice(0, 10);
        const loc = slugify(args.location ?? "india");
        const urls: string[] = [];
        for (const s of slugs) for (let p = 1; p <= (args.pages ?? 2); p++) urls.push(`https://wellfound.com/role/l/${s}/${loc}${p > 1 ? `?page=${p}` : ""}`);
        const cfg = engineConfig(d, "wellfound");
        return envelope("wellfound", cfg, {
          engineLoaded: args.engine_loaded,
          pages: urls,
          steps: [
            "For each URL in pages, in order: navigate to it, load the engine (paste_rule; after the first page loaded_check re-loads it from the page's cache and answers ok), then run await __aupply.scrape(true) on the first page and await __aupply.scrape() on the rest.",
            "After the last page run __aupply.draft() and call queue_jobs with platform 'wellfound' and jobs = its jobs.",
          ],
          rules: ["One page at a time; each scrape scrolls 5 times and takes about 5 seconds."],
        });
      })
  );
}
