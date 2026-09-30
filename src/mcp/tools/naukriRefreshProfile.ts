/**
 * Tool: naukri_refresh_profile
 *
 * Keeps the Naukri profile ranked as active: toggle one key-skill chip so "Profile last
 * updated" reads Today. Chips need real mouse clicks, so this returns steps, not a
 * script; call it again with the result to record which way the chip went.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPreferences } from "../../services/candidate.js";
import { getState, mergeState } from "../../services/automation.js";
import { rulesOf } from "../../platforms/config.js";
import { WRITE, run } from "../toolkit.js";

export function registerNaukriRefreshProfile(server: McpServer): void {
  server.registerTool(
    "naukri_refresh_profile",
    {
      title: "Refresh the Naukri profile",
      description:
        "Keep the user's Naukri profile ranked as recently active by toggling one key-skill chip (remove it if it is " +
        "on the profile, add it back if not), once a day. Returns the steps; chips need real mouse clicks. Call again " +
        "with result once done to record it.",
      inputSchema: {
        result: z
          .object({
            chip: z.string().min(1).max(80),
            action: z.enum(["added", "removed"]),
            last_updated: z.string().max(40).describe("What 'Profile last updated' reads now; Today means it worked."),
          })
          .optional(),
      },
      annotations: WRITE,
    },
    async ({ result }, extra) =>
      run(extra, async (userId) => {
        if (result) {
          await mergeState(userId, "naukri", { refresh: { ...result, at: new Date().toISOString() } });
          return { recorded: true, next: /today/i.test(result.last_updated) ? "Done for today." : "The timestamp did not change: the save did not land. Try once more." };
        }
        const last = (((await getState(userId, "naukri"))?.state as Record<string, any>) ?? {}).refresh ?? null;
        const chip = rulesOf(await getPreferences(userId)).naukri?.refresh_skill ?? null;
        return {
          last_refresh: last,
          chip: chip ?? "any chip in the 'suggested skills' row (pick one that is true of the user)",
          hint: last?.action === "added" ? `Last run added ${last.chip}; this run removes it. Read the chip, not this hint.` : "Read the chips to decide.",
          open: "https://www.naukri.com/mnjuser/profile",
          steps: [
            "Run: document.querySelectorAll('.simplify-jobs-shadow-root').forEach(e=>e.style.setProperty('display','none','important')); document.querySelector('.keySkills .edit.icon').click()",
            "Read the chips: [...document.querySelectorAll('.chip')].map(e=>e.innerText.trim()). Names ending in 'Cross' are on the profile; 'plus' ones are suggestions.",
            "With a REAL mouse click (the computer tool; JS clicks do nothing here) either click the chip's close icon to remove it, or click it in the suggestions to add it.",
            "Scroll the modal down and click Save.",
            "Check (document.body.innerText.match(/Profile last updated\\s*-\\s*([A-Za-z0-9 ,]{3,20})/)||[])[1] and call naukri_refresh_profile with result.",
          ],
          rules: ["Never type into the 'Add skills' box (it drops the last character). Change nothing else on the profile."],
        };
      })
  );
}
