/**
 * One Easy Apply job from page load to result: a port of li_job.js `job()` and `cont()` and the
 * per-job part of li_main.js `runQueue` (src/engines/src/modules), with every live-run lesson
 * kept (BUILD-INSTRUCTIONS.md, Appendix A). The form's answers come from the server, one batch
 * per page; this file only drives the page.
 */

import type { AnswersResponse, ApplyResult, Field } from "../../../../src/extension/contract";
import { FLOORS, LIMITS } from "../../shared/constants";
import { sleep, until } from "../sleep";
import {
  $$, alreadyApplied, applyControl, checkpoint, clickText, closed, deepAll, dismiss, limitHit, loggedOut, modal, navBtn, pageTitle,
  progress, rateLimited, sentTo, setVal, txt, vis,
} from "./dom";
import { applyActions, collectFields, errorTexts, refusedNumbers, repair } from "./form";

export interface Bridge {
  answers(page: { progress: string; index: number }, company: string, fields: Field[]): Promise<AnswersResponse>;
  /** A real (trusted) click at viewport coordinates, made by the service worker through the debugger. */
  trustedClick(x: number, y: number): Promise<boolean>;
  /** Ask the user for a click Aupply could not make; resolves when they are told. */
  handoff(what: "typeahead" | "follow", label: string, value?: string, done?: boolean): Promise<void>;
  progress(note: string): void;
}

export interface JobArgs {
  job: { id: string; company: string; title: string };
  page_wait_ms: number;
  country: string | null;
}

type R = ApplyResult;
const center = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};

// ---------------------------------------------------------------------------
// City typeaheads (li_job `pick`)
// ---------------------------------------------------------------------------

const options = () => deepAll<HTMLElement>("[role=option]").filter(vis);

/** City typeaheads ("Enter city or location" on PyjamaHR and Greenhouse-backed forms) keep a typed
    value only once a suggestion is chosen. Type the value again, wait up to 4s for a suggestion that
    starts with it and names the user's country, choose it the way a pointer does, read the field
    back. A suggestion in another country is never picked. */
async function pick(el: HTMLInputElement, value: string, label: string, country: string | null, bridge: Bridge): Promise<boolean> {
  const want = value.toLowerCase();
  const home = (country || "").toLowerCase();
  const matches = () => options().filter((o) => txt(o).toLowerCase().startsWith(want) && (!home || txt(o).toLowerCase().includes(home)));
  const accepted = () => (el.value || "").toLowerCase().startsWith(want) && el.getAttribute("aria-expanded") !== "true" && !matches().length;
  el.focus();
  setVal(el, "");
  setVal(el, value);
  ["keydown", "keyup"].forEach((t) => el.dispatchEvent(new KeyboardEvent(t, { bubbles: true, key: value.slice(-1) })));
  const found = await until(() => (matches().length ? matches() : null), 4000);
  if (!found) return false;
  const o = found[0];
  const ev = { bubbles: true, cancelable: true, view: window };
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) o.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, ev) : new MouseEvent(t, ev));
  await sleep(800);
  if (accepted()) return true;
  // The synthetic click did not take (1 Oct: 3 of 15 jobs): a trusted click on the suggestion.
  const again = matches()[0] ?? o;
  const { x, y } = center(again);
  if (await bridge.trustedClick(x, y)) {
    await sleep(800);
    if (accepted()) return true;
  }
  // No permission or it failed: the user makes the click (3 minutes).
  await bridge.handoff("typeahead", label, value);
  const ok = await until(accepted, LIMITS.handoffMs);
  await bridge.handoff("typeahead", label, value, true);
  return Boolean(ok);
}

// ---------------------------------------------------------------------------
// "Follow <company>" (li_job `unfollow`)
// ---------------------------------------------------------------------------

function ctxText(e: HTMLInputElement) {
  const l = e.id ? (document.querySelector(`label[for="${e.id}"]`) as HTMLElement | null) : null;
  let t = (l && (l.innerText || l.textContent)) || e.getAttribute("aria-label") || "";
  let p = e.parentElement;
  for (let i = 0; i < 4 && p && !/follow/i.test(t); i++) {
    t = (p.innerText || p.textContent || "") + " " + t;
    p = p.parentElement;
  }
  return t;
}

/** The review page pre-ticks "Follow <company>" and its label is not linked by for: read the
    container text, click the label, then the box, then a pointer sequence; verify. Still ticked:
    a trusted click, else the user. true when every Follow box is off. */
async function unfollow(bridge: Bridge): Promise<boolean> {
  for (const e of $$<HTMLInputElement>("input[type=checkbox]")) {
    if (!/follow .{0,60}(stay up to date|page)/i.test(ctxText(e))) continue;
    if (!e.checked) continue;
    const l = e.id ? (document.querySelector(`label[for="${e.id}"]`) as HTMLElement | null) : null;
    if (l) {
      l.click();
      await sleep(300);
    }
    if (e.checked) {
      e.click();
      await sleep(300);
    }
    if (e.checked) {
      const o = { bubbles: true, cancelable: true, view: window };
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) (l || e).dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, o) : new MouseEvent(t, o));
      await sleep(300);
    }
    if (e.checked) {
      const { x, y } = center(l || e);
      if (await bridge.trustedClick(x, y)) await sleep(500);
    }
    if (e.checked) {
      await bridge.handoff("follow", ctxText(e).replace(/\s+/g, " ").trim().slice(0, 120));
      await until(() => !e.checked, LIMITS.handoffMs);
      await bridge.handoff("follow", "", undefined, true);
    }
    if (e.checked) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The form (li_job `cont`)
// ---------------------------------------------------------------------------

async function cont(args: JobArgs, bridge: Bridge): Promise<R> {
  const trace: string[] = [];
  let repaired = false;
  const company = pageTitle().company || args.job.company;
  for (let i = 0; i < 12; i++) {
    let ta: { label: string } | null = null; // a typeahead picked on this page
    if (!navBtn()) {
      trace.push("nomodal");
      break;
    }
    const prev = progress();
    const c = collectFields();
    if (c.fields.length) {
      bridge.progress(`page ${i + 1}`);
      const ans = await bridge.answers({ progress: prev, index: i }, company, c.fields);
      const done = applyActions(c, ans.actions);
      if (ans.verdict === "protected") return { r: "PROTECTED", need: (ans.questions ?? []).map((q) => q.question), question_ids: (ans.questions ?? []).map((q) => q.id), trace };
      if (ans.verdict === "needs_input") return { r: "NEEDS_INPUT", need: (ans.questions ?? []).map((q) => q.question), question_ids: (ans.questions ?? []).map((q) => q.id), trace };
      // The modal's own Save (an edited section), never the job page's Save, which bookmarks the
      // job (1 Oct: every job the engine filled landed in Saved jobs).
      if (done.changed) {
        const box = modal();
        const sv = box && $$<HTMLButtonElement>("button", box).find((b) => /^save$/i.test(txt(b)) && !/\bjob\b|\bat\b/i.test(b.getAttribute("aria-label") || "") && !/jobs-save/.test(String(b.className || "")));
        if (sv) {
          sv.click();
          await sleep(2000);
        }
      }
      if (done.typeahead) {
        ta = { label: done.typeahead.label };
        if (!(await pick(done.typeahead.el, done.typeahead.value, done.typeahead.label, args.country, bridge))) return { r: "NEEDS_CLICK", need: [done.typeahead.label], trace };
      }
    }
    const labels = $$<HTMLButtonElement>("button").map(txt);
    const nxt =
      labels.find((x) => /^submit application$/i.test(x)) ||
      labels.find((x) => /^review$/i.test(x)) ||
      labels.find((x) => /^next$/i.test(x)) ||
      labels.find((x) => /^continue$/i.test(x));
    trace.push(prev);
    if (!nxt) return { r: "NO_BUTTON", trace };
    if (/^submit/i.test(nxt) && !(await unfollow(bridge))) return { r: "FOLLOW_STUCK", trace };
    clickText(nxt);
    await sleep(2800);
    if (/^submit/i.test(nxt)) break;
    if (prev && progress() === prev && navBtn()) {
      // The same page again: blocked, not slow. One repair pass, then report the stall: first a
      // decimal or a lone number; then the fields still refused as numbers go back to the server
      // for its number (li_fill's repair asks the rules the same way).
      if (!repaired) {
        repaired = true;
        let fixed = repair();
        const refused = refusedNumbers();
        if (refused.fields.length) {
          const ans = await bridge.answers({ progress: prev, index: i }, company, refused.fields);
          fixed = applyActions(refused, ans.actions.filter((a) => a.do === "set")).changed || fixed;
        }
        if (fixed) {
          clickText(nxt);
          await sleep(2800);
          if (progress() !== prev) continue;
        }
      }
      if (ta) return { r: "NEEDS_CLICK", need: [ta.label], trace };
      return { r: "STALL", errs: errorTexts(), trace };
    }
  }
  await sleep(2500);
  const who = sentTo();
  dismiss();
  return { r: who ? "SENT" : "UNCONFIRMED", trace };
}

/** li_job `job`: judge a job only once its apply control has rendered, and call it NO_EASY_APPLY
    only when the company-site Apply is on screen: that verdict skips the job for good. */
async function job(args: JobArgs, bridge: Bridge): Promise<R> {
  if (closed()) return { r: "CLOSED" };
  if (!navBtn()) {
    const ctl = await until(() => applyControl() || (closed() && "closed") || (alreadyApplied() && "applied") || null, FLOORS.pollMs);
    if (ctl === "closed") return { r: "CLOSED" };
    if (ctl === "applied") return { r: "ALREADY_APPLIED" };
    if (!ctl) return { r: "NOT_LOADED" };
    if (!ctl.easy) return { r: "NO_EASY_APPLY" };
    ctl.el.click();
    await until(() => navBtn() || limitHit(), FLOORS.pollMs);
  }
  // The cap dialog: body text first (it is visible), shadow roots second.
  if (limitHit()) {
    const g = deepAll<HTMLButtonElement>("button").find((b) => /^got it$/i.test(txt(b)));
    if (g) g.click();
    return { r: "DAILY_LIMIT" };
  }
  if (!navBtn()) return { r: "NO_MODAL" };
  return cont(args, bridge);
}

/** li_main `discard`: close a modal left open by a non-final result. */
async function discard() {
  const x = deepAll<HTMLButtonElement>("button").find((b) => /^dismiss$/i.test(b.getAttribute("aria-label") || ""));
  if (x) {
    x.click();
    await sleep(1200);
  }
  const d = deepAll<HTMLButtonElement>("button").find((b) => /^discard$/i.test(txt(b)));
  if (d) {
    d.click();
    await sleep(1200);
  }
}

const FINAL = /^(SENT|UNCONFIRMED|CLOSED|NO_EASY_APPLY|ALREADY_APPLIED)$/;

/** One job, as li_main's runQueue runs it after navigating: the page wait, the Rate Limited page,
    the page title naming the company, then the job under its 4 minute limit. */
export async function applyJob(args: JobArgs, bridge: Bridge): Promise<R> {
  let hid = document.hidden;
  const onVis = () => {
    if (document.hidden) hid = true;
  };
  document.addEventListener("visibilitychange", onVis);
  try {
    await sleep(Math.max(args.page_wait_ms, FLOORS.pageWaitMs));
    if (checkpoint()) return { r: "CHECKPOINT" };
    if (loggedOut()) return { r: "LOGGED_OUT" };
    if (rateLimited()) return { r: "RATE_LIMITED" };
    // The title can trail the navigation, more so in a hidden tab (1 Oct: a TITLE_MISMATCH).
    const co = args.job.company.toLowerCase().slice(0, 6);
    const named = () => !co || (document.title || "").toLowerCase().includes(co);
    if (!(await until(named, FLOORS.pollMs))) return { r: "TITLE_MISMATCH", page: pageTitle() };
    let res: R;
    // One job, 4 minutes at most (li_main `withLimit`). One shallow timer, cleared when the job ends.
    let limit: ReturnType<typeof setTimeout> | undefined;
    try {
      res = await Promise.race([
        job(args, bridge),
        new Promise<R>((resolve) => (limit = setTimeout(() => resolve({ r: "ERR", e: "job_timeout" }), FLOORS.jobMaxMs))),
      ]);
    } catch (err) {
      res = { r: "ERR", e: String((err as Error)?.message ?? err).slice(0, 300) };
    } finally {
      clearTimeout(limit);
    }
    if (!FINAL.test(res.r)) await discard();
    return { ...res, page: pageTitle(), ...(hid ? { hid: true } : {}) };
  } finally {
    document.removeEventListener("visibilitychange", onVis);
  }
}
