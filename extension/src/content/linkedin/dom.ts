/**
 * Readers for the LinkedIn job page and its Easy Apply modal, a port of li_dom.js
 * (src/engines/src/modules/li_dom.js) with every live-run lesson kept (BUILD-INSTRUCTIONS.md,
 * Appendix A). Only reading and low-level setting here; the decisions are the server's.
 */

/** CSS.escape where the page has it (jsdom does not). */
const nativeEscape = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
export const cssEsc = (s: string) => (nativeEscape ? nativeEscape(s) : s.replace(/["\\\]\[]/g, "\\$&"));

export const txt = (e: Element | null | undefined) => (((e as HTMLElement | null)?.innerText || e?.textContent || "") as string).replace(/\s+/g, " ").trim();
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

/** Rendered with a size: hidden inputs and collapsed sections are not fields. */
export const vis = (e: Element) => {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

// li_dom `navBtn`: the modal's own navigation.
export const navBtn = () => $$<HTMLButtonElement>("button").find((b) => /^(next|review|submit application|continue)$/i.test(txt(b))) ?? null;

/** li_dom `modal`: no role="dialog" and obfuscated classes, so anchor it from its nav button:
    walk up at most 14 parents to the element whose text has "Apply to " and holds a control. */
export function modal(): HTMLElement | null {
  const nb = navBtn();
  if (!nb) return null;
  let p: HTMLElement | null = nb;
  for (let i = 0; i < 14 && p; i++) {
    p = p.parentElement;
    if (!p) break;
    if (/Apply to /.test(p.innerText || p.textContent || "") && p.querySelector("input,select,textarea,button")) return p;
  }
  return (nb.closest("form") as HTMLElement | null) || nb.parentElement;
}

/** li_dom `lab`: a label only from a container holding exactly one control (the old walk read a
    neighbour's label and typed a first name into a city field). Capped at 500 characters. */
export function lab(el: Element): string {
  let l = "";
  const ref = el.getAttribute("aria-labelledby");
  if (ref) {
    const n = document.getElementById(ref.split(/\s+/)[0]);
    if (n) l = (n as HTMLElement).innerText || n.textContent || "";
  }
  const labels = (el as HTMLInputElement).labels;
  if (!l && labels && labels[0]) l = labels[0].innerText || labels[0].textContent || "";
  if (!l && el.id) {
    const x = document.querySelector(`label[for="${cssEsc(el.id)}"]`) as HTMLElement | null;
    if (x) l = x.innerText || x.textContent || "";
  }
  if (!l) {
    let p = el.parentElement;
    for (let i = 0; i < 4 && p && !l; i++) {
      if (p.querySelectorAll("input,select,textarea").length === 1) {
        const q = p.querySelector("label,legend") as HTMLElement | null;
        if (q) l = q.innerText || q.textContent || "";
      }
      p = p.parentElement;
    }
  }
  if (!l) l = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el as HTMLInputElement).name || "";
  return l.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** li_dom `optText`: label[for], else the nearest short ancestor text (under 40 characters). */
export function optText(e: Element): string {
  if (e.id) {
    const x = document.querySelector(`label[for="${cssEsc(e.id)}"]`) as HTMLElement | null;
    const t = (x?.innerText || x?.textContent || "").trim();
    if (t) return t.replace(/\s+/g, " ");
  }
  let p: Element | null = e;
  for (let i = 0; i < 5 && p; i++) {
    p = p.parentElement;
    if (!p) continue;
    const t = ((p as HTMLElement).innerText || p.textContent || "").replace(/\s+/g, " ").trim();
    if (t && t.length < 40) return t;
  }
  return "";
}

/** li_dom `qOf`: a radio group's question: the fieldset legend, else the previous sibling's text,
    else the smallest container holding all options, walking up while trimming trailing "Yes No". */
export function qOf(els: Element[]): string {
  const fs = els[0].closest("fieldset");
  let q = "";
  if (fs) {
    const lg = fs.querySelector("legend") as HTMLElement | null;
    if (lg) q = lg.innerText || lg.textContent || "";
    if (!q && fs.previousElementSibling) q = (fs.previousElementSibling as HTMLElement).innerText || fs.previousElementSibling.textContent || "";
  }
  if (!q) {
    let c: Element = els[0];
    while (c.parentElement && !els.every((e) => c.contains(e))) c = c.parentElement;
    let p: Element | null = c;
    for (let i = 0; i < 4 && p && !q; i++) {
      let t = ((p as HTMLElement).innerText || p.textContent || "").replace(/\s+/g, " ").trim();
      t = t.replace(/(\s*(Yes|No))+\s*$/, "");
      if (t.length >= 15) q = t;
      p = p.parentElement;
    }
  }
  return q.replace(/\s+/g, " ").replace(/\*$/, "").trim().slice(0, 500);
}

/** li_dom `progress`: "2/4 pages" or "50%" in the modal. */
export const progress = () => {
  const m = modal();
  return ((m ? m.innerText || m.textContent || "" : "").match(/(\d+)\s*\/\s*(\d+)\s*pages|\d+%/) || [])[0] || "";
};

/** li_dom `setVal`: the native value setter of the element's prototype, then input and change. */
export function setVal(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, v: string) {
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export const clickText = (t: string) => {
  const b = $$<HTMLButtonElement>("button").find((x) => txt(x).toLowerCase() === t.toLowerCase());
  if (!b) return false;
  b.click();
  return true;
};

/** li_dom `deepAll`: the success message and the daily-limit dialog render in shadow roots. */
export function deepAll<T extends Element = HTMLElement>(sel: string): T[] {
  const out: T[] = [];
  const walk = (r: ParentNode | null) => {
    if (!r || !(r as ParentNode).querySelectorAll) return;
    try {
      out.push(...(r.querySelectorAll(sel) as NodeListOf<T>));
    } catch {
      /* ignore */
    }
    r.querySelectorAll("*").forEach((e) => {
      if ((e as Element).shadowRoot) walk((e as Element).shadowRoot);
    });
  };
  walk(document);
  return out;
}

/** The page's text and every shadow root's. (The MCP engine started this walk at `document`, whose
    textContent is always null, so it read shadow roots only; the plan's rule is "shadow DOM too".) */
export function deepText(): string {
  let out = "";
  const walk = (r: Node | null) => {
    if (!r) return;
    out += " " + ((r.nodeType === 9 ? (r as Document).documentElement?.textContent : r.textContent) || "");
    (r as ParentNode).querySelectorAll?.("*").forEach((e) => {
      if ((e as Element).shadowRoot) walk((e as Element).shadowRoot);
    });
  };
  walk(document);
  return out.replace(/\s+/g, " ");
}

/** "application was sent to <company>" means SENT. */
export const sentTo = () => {
  const m = deepText().match(/application was sent to ([^!]{1,45})/i);
  return m ? m[1].trim() : null;
};
export const dismiss = () => {
  const b = deepAll<HTMLButtonElement>("button").find((x) => /^(not now|done|dismiss|no thanks)$/i.test((x.innerText || x.textContent || "").trim()));
  if (b) b.click();
};
/** "reached today's Easy Apply limit": DAILY_LIMIT. */
export const limitHit = () => /reached today'?s easy apply limit|easy apply limit/i.test((document.body.innerText || document.body.textContent || "") + " " + deepText());

/** li_dom `applyControl`: Easy Apply (a button or a link), else the company-site Apply; null
    until the job's top card has rendered. */
export function applyControl(): { easy: boolean; el: HTMLElement } | null {
  const all = deepAll<HTMLElement>("button,a");
  const easyEl =
    all.find((x) => /^easy apply$/i.test(txt(x))) ||
    all.find((x) => /easy apply to this job/i.test(x.getAttribute("aria-label") || "")) ||
    all.find((x) => /^easy apply/i.test(txt(x)));
  if (easyEl) return { easy: true, el: easyEl };
  const site = all.find((x) => /^apply$/i.test(txt(x)) || /on company website/i.test(x.getAttribute("aria-label") || ""));
  return site ? { easy: false, el: site } : null;
}

export const closed = () => /no longer accepting applications/i.test(document.body.innerText || document.body.textContent || "");
export const alreadyApplied = () =>
  /\byou applied\b|\bapplied \d+ (second|minute|hour|day|week|month)s? ago\b|application submitted/i.test(document.body.innerText || document.body.textContent || "");

/** "Job title | Company | LinkedIn" */
export const pageTitle = () => {
  const p = (document.title || "").split("|").map((x) => x.trim());
  return { title: p[0] ?? "", company: p[1] ?? "" };
};

/** li_base `trackerCount`: "Applied · N" (also "•", ":", "-"), commas removed. */
export const trackerCount = () => {
  const m = (document.body.innerText || document.body.textContent || "").match(/Applied\s*[·•:-]\s*([\d,]+)/i);
  return m ? +m[1].replace(/,/g, "") : null;
};

/** The page LinkedIn shows when it throttles: "Rate limited" in the title (li_main). */
export const rateLimited = () => /rate limited/i.test(document.title || "");

/** Signed out: a login or auth wall URL, or a sign-in form. */
export const loggedOut = () =>
  /^\/(login|authwall|uas\/login|signup)/.test(location.pathname) || Boolean(document.querySelector('form[action*="login-submit"], input#username[name="session_key"]'));
/** A security check or CAPTCHA: never touched; the run stops and the user is told. */
export const checkpoint = () =>
  /^\/checkpoint\//.test(location.pathname) || Boolean(document.querySelector('iframe[src*="captcha"], iframe[title*="captcha" i], #captcha-internal'));
