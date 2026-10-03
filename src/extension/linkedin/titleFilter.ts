/**
 * The title filter, a port of li_sweep.js (the loop after the searches, "NEGT ... title_years"):
 * the same checks in the same order with the same reason codes, on the screening config the
 * MCP compiles (src/platforms/config.ts `screening`). Title rejects are counted, never stored
 * (a regex on a card costs nothing).
 */

import type { Card } from "./guest.js";

export type TitleDrop = "title_seniority" | "title_stack" | "company" | "title_off_target" | "title_years";

export interface TitleRules {
  negTitle: string | null;
  negStack: string | null;
  pos: string | null;
  spam: string | null;
  agg: string | null;
  maxYears: number | null;
}

const re = (src: string | null) => (src ? new RegExp(src, "i") : null);
// li_sweep: years in a title ("Backend Engineer 5+ yrs", "3 YOE").
const YT = /(\d{1,2})\s*\+?\s*(?:yoe|yrs?|years?)\b/i;

export function titleFilter(rules: TitleRules) {
  const NEGT = re(rules.negTitle), NEGS = re(rules.negStack), POS = re(rules.pos), SPAM = re(rules.spam), AGG = re(rules.agg);
  return {
    /** The reason a card is dropped, or null when it stays. */
    drop(c: Card): TitleDrop | null {
      const y = YT.exec(c.t);
      if (NEGT && NEGT.test(c.t)) return "title_seniority";
      if (NEGS && (NEGS.test(c.t) || NEGS.test(c.co))) return "title_stack";
      if (SPAM && SPAM.test(c.co)) return "company";
      if (POS && !POS.test(c.t)) return "title_off_target";
      if (y && rules.maxYears != null && +y[1] > rules.maxYears) return "title_years";
      return null;
    },
    /** Job-ad networks (Joveo, Jobgether...): applications land but never get a reply; ranked last. */
    agg: (c: Card) => (AGG && AGG.test(c.co) ? 1 : 0),
  };
}
