/**
 * Tool: linkedin_draft
 *
 * Builds today's LinkedIn Easy Apply queue (30 to 40 jobs): returns the engine and the
 * steps sweep -> check_applied -> prescreen -> queue_jobs, all in one page lifetime on
 * the tracker page. Easy Apply only, last hour first, never older than 24h.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engineConfig, loadUserData, rulesOf } from "../../platforms/config.js";
import { envelope } from "../../platforms/envelope.js";
import { blocked } from "../../platforms/jobs.js";
import { activeBlock, linkedinCap } from "../../services/automation.js";
import { READ_ONLY, run } from "../toolkit.js";

export const LINKEDIN_TRACKER = "https://www.linkedin.com/jobs-tracker/?stage=applied";

export function registerLinkedinDraft(server: McpServer): void {
  server.registerTool(
    "linkedin_draft",
    {
      title: "Draft the LinkedIn queue",
      description:
        "Build today's LinkedIn Easy Apply queue: the 30 to 40 best new jobs for the user, screened by their " +
        "preferences, minus everything Aupply already knows. Returns a script (~28KB) to paste into the user's browser on " +
        "the LinkedIn jobs tracker page. The script stays alive for the whole session and the exact steps (sweep, check_applied, prescreen, " +
        "queue_jobs) use expressions like __aupply.sweep() to draft jobs. Easy Apply only; last hour first, then the last 24 hours. " +
        "The script paces itself to stay under LinkedIn's rate limits; never shorten a wait. Refuses while LinkedIn is in a backoff or today's quota is used.",
      inputSchema: {
        windows: z.array(z.enum(["1h", "24h"])).max(2).optional().describe("Default both, last hour first."),
        keywords: z.array(z.string().min(2).max(80)).max(12).optional().describe("Default: the user's desired roles."),
        target: z.number().int().min(5).max(60).optional().describe("Jobs to keep. Default 40."),
        engine_loaded: z.string().max(40).optional().describe("The engine id already loaded in this page."),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(extra, async (userId) => {
        const block = await activeBlock(userId, ["linkedin", "linkedin_guest"]);
        if (block) return blocked(block);
        const d = await loadUserData(userId);
        const cap = await linkedinCap(userId, rulesOf(d.prefs));
        if (cap.left <= 0) {
          return { skip: true, reason: `Today's LinkedIn quota is used (${cap.used} of ${cap.cap}).`, next: "Skip LinkedIn today; draft Naukri or Wellfound." };
        }
        const cfg = engineConfig(d, "linkedin", {
          screen: {
            ...(args.windows ? { windows: args.windows.map((w) => (w === "1h" ? "r3600" : "r86400")) } : {}),
            ...(args.keywords ? { keywords: args.keywords.map((k) => [k, 3]) } : {}),
            ...(args.target ? { target: args.target } : {}),
          },
        });
        if (!(cfg.screen as { keywords?: unknown[] }).keywords?.length) {
          return { skip: true, reason: "No roles to search for.", next: "Ask the user which roles to search, save them with update_profile (preferences.desired_roles), then call linkedin_draft again." };
        }
        return envelope("linkedin", cfg, {
          engineLoaded: args.engine_loaded,
          cap_left: cap.left,
          open: LINKEDIN_TRACKER,
          steps: [
            `Open ${LINKEDIN_TRACKER} (stay if already there) and keep this tab for every step below.`,
            "If loaded_check is not true on the page, paste inject as the browser tool's source (it's ~28KB and the tool handles it fine). The result will be {ok:true}.",
            "Run __aupply.sweep(), then await __aupply.wait(35000) until an item with phase 'swept' arrives. Keep its ids and tracker.",
            "Call check_applied with platform 'linkedin' and external_ids = those ids.",
            "Run __aupply.prescreen({skip: <the ids in check_applied.known>}), then await __aupply.wait(35000) until phase 'screened'. If paused_until shows, the script is waiting out a rate limit: keep polling or work another platform meanwhile.",
            "Call queue_jobs with platform 'linkedin', jobs = keep, skipped = drop, stop = stop (if present) and tracker = the tracker from the sweep.",
          ],
          rules: [
            "Stay on this page: a real navigation wipes the sweep. Never open a second tab while a script runs.",
            "Never rerun a step early or shorten a wait: the pacing is LinkedIn's rate limit.",
          ],
        });
      })
  );
}
