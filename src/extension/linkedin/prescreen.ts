/**
 * The JD prescreen, a port of li_screen.js `jd()` (src/engines/src/modules/li_screen.js): the
 * same checks in the same order with the same codes. `clean`, `yearsOf` and `payMax` are the
 * built engine's own functions (engine/modules.ts), never copies of their regexes.
 */

import { STACK_VOCAB } from "../../platforms/knowledge.js";
import { engineDefs, payMax } from "../engine/modules.js";

export interface ScreenRules {
  jdExclude: string | null;
  maxYears: number | null;
  skipMidSenior: boolean;
  minPay: number | null;
  /** Far technologies for this user: [name, regex]. */
  stack: [string, string][];
  /** Technologies the user excluded by name. */
  noStack: string[];
}

export type DropCode = "CLOSED" | "DROP_ATS" | "DROP_JD_EXCLUDE" | "DROP_YEARS" | "DROP_MIDSENIOR" | "DROP_PAY" | "DROP_STACK";

export interface Keep { minY: number | null; yu?: number; lvl: string | null; pay: number | null; sm: string[] }

export interface Screened {
  /** The posting as text, for the shared cache and the AI. */
  text: string;
  lvl: string | null;
  ats: string | null;
  /** Every STACK_VOCAB technology the posting names (for the future global jobs table). */
  stackAll: string[];
  verdict: { code: "keep"; keep: Keep } | { code: DropCode };
}

const LEVEL = /Seniority level\s*(Internship|Entry level|Associate|Mid-Senior level|Director|Executive|Not Applicable)/i;
const ATS = /applicantTrackingSystemName(?:=|%3D|"\s*:\s*")([A-Za-z]+)/;

export function stackAll(text: string): string[] {
  return STACK_VOCAB.filter((t) => new RegExp(t.re, "i").test(text)).map((t) => t.name);
}

/** Screen one guest JD response body. `raw` is the HTML (the ATS name is read from it). */
export function prescreen(raw: string, sc: ScreenRules): Screened {
  const { clean } = engineDefs();
  return prescreenText(clean(raw), (raw.match(ATS) || [])[1] ?? null, sc);
}

/** The same checks on a posting already in the shared cache (its text and ATS name). */
export function prescreenText(t: string, ats: string | null, sc: ScreenRules): Screened {
  const { yearsOf } = engineDefs();
  const lvlRaw = (t.match(LEVEL) || [])[1] ?? null;
  const base = { text: t, ats, lvl: lvlRaw && !/not applicable/i.test(lvlRaw) ? lvlRaw : null, stackAll: stackAll(t) };
  const drop = (code: DropCode): Screened => ({ ...base, verdict: { code } });
  if (/no longer accepting applications/i.test(t)) return drop("CLOSED");
  if (ats && !/linkedin/i.test(ats)) return drop("DROP_ATS");
  if (sc.jdExclude && new RegExp(sc.jdExclude, "i").test(t)) return drop("DROP_JD_EXCLUDE");
  const y = yearsOf(t);
  if (y.minY != null && !y.yu && sc.maxYears != null && y.minY > sc.maxYears) return drop("DROP_YEARS");
  if (y.minY == null && sc.skipMidSenior && /mid-senior|director|executive/i.test(lvlRaw || "")) return drop("DROP_MIDSENIOR");
  const pay = payMax(t);
  if (pay != null && sc.minPay && pay < sc.minPay) return drop("DROP_PAY");
  const sm = sc.stack.filter((s) => new RegExp(s[1], "i").test(t)).map((s) => s[0]);
  // A technology the user excluded by name: skipped here, so it never takes a queue place.
  if (sm.some((n) => sc.noStack.includes(n))) return drop("DROP_STACK");
  return { ...base, verdict: { code: "keep", keep: { minY: y.minY, ...(y.yu ? { yu: 1 } : {}), lvl: base.lvl, pay, sm } } };
}
