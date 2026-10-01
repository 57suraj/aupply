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
        "preferences, minus everything Aupply already knows. Returns the exact steps (sweep, check_applied, prescreen, " +
        "queue_jobs) and the id of the draft engine for the LinkedIn jobs tracker page; load_engine brings it into the " +
        "page (load_rule). Easy Apply only; last hour first, then the last 24 hours. The engine paces itself to stay under " +
        "LinkedIn's rate limits; never shorten a wait. Refuses while LinkedIn is in a backoff or today's quota is used.",
      inputSchema: {
        windows: z.array(z.enum(["1h", "24h"])).max(2).optional().describe("Default both, last hour first."),
        keywords: z.array(z.string().min(2).max(80)).max(12).optional().describe("Default: the user's desired roles."),
        target: z.number().int().min(5).max(60).optional().describe("Jobs to keep. Default 40."),
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
          only: "screen",
          screen: {
            ...(args.windows ? { windows: args.windows.map((w) => (w === "1h" ? "r3600" : "r86400")) } : {}),
            ...(args.keywords ? { keywords: args.keywords.map((k) => [k, 3]) } : {}),
            ...(args.target ? { target: args.target } : {}),
          },
        });
        if (!(cfg.screen as { keywords?: unknown[] }).keywords?.length) {
          return { skip: true, reason: "No roles to search for.", next: "Ask the user which roles to search, save them with update_profile (preferences.desired_roles), then call linkedin_draft again." };
        }
        return envelope(userId, "linkedin_draft", cfg, {
          cap_left: cap.left,
          open: LINKEDIN_TRACKER,
          steps: [
            `Open ${LINKEDIN_TRACKER} (stay if already there; a LinkedIn tab left open from earlier may still hold the engine) and keep this tab for every step below.`,
            "Load the engine (load_rule). It stays loaded while this page stays open.",
            "Run __aupply.sweep(), then await __aupply.wait(35000) until a 'swept' item with done:1 arrives. The ids come in several 'swept' items before it: collect the ids of all of them, and keep the tracker of the done:1 item.",
            "Call check_applied with platform 'linkedin' and external_ids = those ids.",
            "Run __aupply.prescreen({skip: <the ids in check_applied.known>}), then await __aupply.wait(35000) until a 'screened' item with done:1 arrives. The items before it carry keep or drop lists: collect every keep entry and every drop entry as-is. If paused_until shows, the script is waiting out a rate limit: keep polling or work another platform meanwhile.",
            "Call queue_jobs once with platform 'linkedin', jobs = all the keep entries, skipped = all the drop entries, stop = the done:1 item's stop (if present) and tracker = the tracker from the sweep.",
          ],
          rules: [
            "Stay on this page: a real navigation wipes the sweep. Never open a second tab while a script runs.",
            "Never rerun a step early or shorten a wait: the pacing is LinkedIn's rate limit.",
          ],
        });
      })
  );
}
