/**
 * Tool: indeed_draft
 *
 * Builds the Indeed queue from in.indeed.com search pages (newest first, last day),
 * keeping only "Easily apply" jobs that pass the user's screening, then queue_jobs.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engineConfig, loadUserData } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { blocked } from "../../platforms/jobs.js";
import { activeBlock } from "../../services/automation.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerIndeedDraft(server: McpServer): void {
  server.registerTool(
    "indeed_draft",
    {
      title: "Draft the Indeed queue",
      description:
        "Build the Indeed queue: returns in.indeed.com search pages (newest first) and a script that keeps only " +
        "'Easily apply' jobs passing the user's screening. Then pass draft() to queue_jobs. Jobs found through the " +
        "Indeed connector or Indeed alert emails can go to queue_jobs directly (source connector / alert_email).",
      inputSchema: {
        queries: z.array(z.string().min(2).max(100)).max(6).optional().describe("Default: the user's desired roles."),
        locations: z.array(z.string().min(2).max(60)).max(4).optional().describe("Default: the user's city and Remote."),
        fromage: z.union([z.literal(1), z.literal(3)]).optional().describe("Posted within N days. Default 1."),
        engine_loaded: z.string().max(40).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        const block = await activeBlock(userId, ["indeed"]);
        if (block) return blocked(block);
        const d = await loadUserData(userId);
        const queries = (args.queries ?? d.prefs.desired_roles).slice(0, 4);
        if (!queries.length) return { error: "No search terms: pass queries or set desired roles in the user's preferences." };
        const locations = args.locations ?? [d.profile.location_city ?? "India", "Remote"];
        const urls = queries.flatMap((q) =>
          locations.map((l) => `https://in.indeed.com/jobs?q=${encodeURIComponent(q)}&l=${encodeURIComponent(l)}&fromage=${args.fromage ?? 1}&sort=date`)
        );
        const cfg = engineConfig(d, "indeed");
        return envelope("indeed", cfg, {
          engineLoaded: args.engine_loaded,
          pages: urls,
          steps: [
            "For each URL in pages, in order: navigate to it, load the engine (paste_rule; after the first page loaded_check re-loads it from the page's cache and answers ok), then run __aupply.scrape(true) on the first page and __aupply.scrape() on the rest.",
            "After the last page run __aupply.draft() and call queue_jobs with platform 'indeed' and jobs = its jobs.",
          ],
          rules: [
            "Indeed connector (if you have it): serial calls only, 20 seconds apart; on a -32429 error stop using it for this run.",
            "Connector titles are often not the JD's title and its ids (JOBSEARCH_nn, to.indeed.com links) change on every call: read the JD before accepting or rejecting, and pass the jk, never the connector id.",
          ],
        });
      })
  );
}
