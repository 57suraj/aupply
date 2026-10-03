/**
 * What to do with one Easy Apply form field, decided on the server (decision E5). A port of
 * the decisions li_fill.js `fill()` and `dateFill()` make in the page
 * (src/engines/src/modules/li_fill.js), in the same order and for the same reasons, plus the
 * number-field rules of resolveAnswers' `numeric()` (src/services/resolve.ts). The resolver
 * itself (R.A, R.pickOpt, R.lowStakes) is the MCP's own, loaded from the built modules; nothing
 * here re-decides what it answers. The extension only collects fields and applies actions.
 */

import type { ResolverAnswer } from "../../platforms/resolver.js";
import type { Action, Field } from "../contract.js";
import type { FullResolver } from "../engine/modules.js";

export interface FieldCtx {
  R: FullResolver;
  /** answerPack(d).me: the user's facts. */
  me: Record<string, any>;
  company: string;
  NEVERTICK: RegExp;
  CONSENT: RegExp;
}

export interface Decided {
  action: Action;
  /** What was answered, for the Q&A log (none for "leave"). */
  qa?: { question: string; answer: string; a: ResolverAnswer | null; source: string };
}
export type FieldDecision =
  | ({ fid: string; kind: "decided" } & Decided)
  | { fid: string; kind: "unknown"; a: ResolverAnswer | null }
  | { fid: string; kind: "protected"; what: string };

// li_fill `whole`: LinkedIn's years fields take whole numbers only (1 Oct: 0.5 is "Invalid input").
const whole = (v: string) => (/^\d+\.\d+$/.test(v) ? String(Math.round(+v)) : v);
const NUM = /^\d+(\.\d+)?$/;

/** resolveAnswers' numeric(): a number field never gets "Yes". No is 0; a saved phrase takes the
    rule's number (alt), else its one number; a phrase with several numbers is not glued together
    (2 Oct: "10 LPA (1000000 INR per year)" became 101000000); a word with no number is the years. */
export function numberValue(answer: string, a: ResolverAnswer | null, years: number | null): string | null {
  if (NUM.test(answer)) return answer;
  if (/^no$/i.test(answer)) return "0";
  if (a?.alt?.v != null && NUM.test(String(a.alt.v))) return String(a.alt.v);
  const nums = answer.match(/\d+(?:\.\d+)?/g) ?? [];
  if (nums.length === 1) return nums[0];
  if (nums.length) return null;
  return years == null ? null : String(Math.round(years));
}

const sourceOf = (a: ResolverAnswer | null) => (!a ? "none" : a.k === "saved" ? "saved" : `registry:${a.k}`);
const opt = (f: Field, i: number) => f.options?.[i] ?? "";
const emptyValue = (f: Field, i: number) => Boolean(f.option_values_empty?.[i]);

export function decideField(f: Field, ctx: FieldCtx): FieldDecision {
  const { R, me, company } = ctx;
  const decided = (action: Action, answer?: string, a: ResolverAnswer | null = null, source?: string): FieldDecision => ({
    fid: f.fid, kind: "decided", action, ...(answer !== undefined ? { qa: { question: f.label, answer, a, source: source ?? sourceOf(a) } } : {}),
  });
  const leave = () => decided({ fid: f.fid, do: "leave" });
  const options = f.options ?? [];

  switch (f.kind) {
    // li_fill `dateFill`: month/year selects with no label: the education dates when the modal
    // is about education, else the current job's start month and year.
    case "date_select": {
      const d = f.date;
      if (!d) return leave();
      const plan = d.context === "education" ? [me.eduFromM, me.eduFromY, me.eduToM, me.eduToY] : [me.expFromM, me.expFromY, "", ""];
      const want = plan[d.index];
      if (!want) return leave();
      const i = options.findIndex((o) => o.trim() === String(want));
      if (i < 0) return leave();
      // These selects have no label; the Q&A log names them.
      const name = `${d.context === "education" ? "Education" : "Current job"} ${d.index < 2 ? "start" : "end"} ${d.index % 2 ? "year" : "month"}`;
      return { fid: f.fid, kind: "decided", action: { fid: f.fid, do: "choose", index: i }, qa: { question: f.label || name, answer: String(want), a: null, source: "date" } };
    }

    // li_fill: a select is unknown whether or not it is required.
    case "select": {
      const a = R.A(f.label, company);
      if (a?.protected) return { fid: f.fid, kind: "protected", what: a.what ?? "protected" };
      let i = R.pickOpt(a, options);
      let source = sourceOf(a);
      if (i < 0 || emptyValue(f, i)) {
        i = R.lowStakes(f.label, options);
        source = "registry:low_stakes";
      }
      if (i >= 0 && !emptyValue(f, i)) return decided({ fid: f.fid, do: "choose", index: i }, opt(f, i), a, source);
      return { fid: f.fid, kind: "unknown", a };
    }

    case "text":
    case "textarea":
    case "number":
    case "typeahead": {
      const a = R.A(f.label, company);
      if (a?.protected) return f.required ? { fid: f.fid, kind: "protected", what: a.what ?? "protected" } : leave();
      let v: string | null = a ? (a.text != null ? String(a.text) : a.v != null ? String(a.v) : null) : null;
      if (v != null && a && /^experience\.(years|tech)$/.test(a.k)) v = whole(v);
      if (v != null && f.kind === "number") v = numberValue(v, a, me.years ?? null);
      if (v == null || v === "") return f.required ? { fid: f.fid, kind: "unknown", a } : leave();
      if (f.max_length && v.length > f.max_length) v = v.slice(0, f.max_length);
      return decided({ fid: f.fid, do: "set", value: v }, v, a);
    }

    case "radio": {
      // li_fill: the resume choice (labels naming a .pdf or "resume") takes the first one.
      if (/\.pdf|resume/i.test(f.label)) return decided({ fid: f.fid, do: "choose", index: 0 }, opt(f, 0), null, "resume");
      const a = R.A(f.label, company);
      if (a?.protected) return { fid: f.fid, kind: "protected", what: a.what ?? "protected" };
      let i = R.pickOpt(a, options);
      let source = sourceOf(a);
      if (i < 0) {
        i = R.lowStakes(f.label, options);
        source = "registry:low_stakes";
      }
      // li_fill: an employer-misconfigured question (a years question wired to Yes/No): Yes, but only
      // when the resolver did answer it positively. An unknown question goes to the user.
      if (i < 0 && a && a.v != null && a.days == null && a.money == null && !/^(no|0)$/i.test(String(a.v)) && options.length === 2) {
        i = options.findIndex((t) => /^yes/i.test(t));
        source = sourceOf(a);
      }
      if (i >= 0) return decided({ fid: f.fid, do: "choose", index: i }, opt(f, i), a, source);
      return { fid: f.fid, kind: "unknown", a };
    }

    // li_fill: a group whose every box is consent or never-tick is a set of lone boxes (consent
    // ticked, marketing, SMS and "follow" never); otherwise the question picks one box.
    case "checkbox_group": {
      if (options.length && options.every((t) => ctx.CONSENT.test(t) || ctx.NEVERTICK.test(t))) {
        const ticks = options.map((t, i) => (!ctx.NEVERTICK.test(t) && ctx.CONSENT.test(t) ? i : -1)).filter((i) => i >= 0);
        if (!ticks.length) return leave();
        return decided({ fid: f.fid, do: "choose", index: ticks[0] }, "consent", null, "consent");
      }
      const a = R.A(f.label, company);
      if (a?.protected) return { fid: f.fid, kind: "protected", what: a.what ?? "protected" };
      const i = R.pickOpt(a, options);
      if (i >= 0) return decided({ fid: f.fid, do: "choose", index: i }, opt(f, i), a);
      return f.required ? { fid: f.fid, kind: "unknown", a } : leave();
    }

    case "checkbox": {
      if (ctx.NEVERTICK.test(f.label)) return leave();
      if (ctx.CONSENT.test(f.label)) return decided({ fid: f.fid, do: "tick" }, "ticked", null, "consent");
      return leave();
    }
  }
}

/** For a consent-only checkbox group: every consent box (never a never-tick one) as its own action. */
export function consentTicks(f: Field, ctx: FieldCtx): Action[] {
  return (f.options ?? [])
    .map((t, i) => (!ctx.NEVERTICK.test(t) && ctx.CONSENT.test(t) ? i : -1))
    .filter((i) => i >= 0)
    .map((index) => ({ fid: f.fid, do: "choose" as const, index }));
}
