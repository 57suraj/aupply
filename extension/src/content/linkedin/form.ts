/**
 * The Easy Apply form: collect what still needs a value, as field descriptors the server can
 * decide on (section 9.3), and apply the server's actions. A port of the reading half of
 * li_fill.js `fill()` and `dateFill()` (src/engines/src/modules/li_fill.js): the same skip rules
 * (a select already on a real option and a filled input are left alone), the same required test,
 * the same label readers. The decisions live on the server (src/extension/linkedin/fields.ts).
 */

import type { Action, Field } from "../../../../src/extension/contract";
import { $$, lab, modal, optText, qOf, setVal, txt, vis } from "./dom";

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
export interface Collected {
  fields: Field[];
  /** fid -> the element(s) behind it. */
  els: Map<string, Control[]>;
}

const PLACEHOLDER = /^(select|choose)/i;
// li_fill: required is the attribute, aria-required, or a label ending in "*".
const isRequired = (el: Element, label: string) =>
  (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label);
const clean = (label: string) => label.replace(/\s*\*\s*$/, "").trim();

/** li_dom `fields`: visible controls in the modal, not hidden, not the "select language" control. */
function controls(m: HTMLElement): Control[] {
  return $$<Control>("input,select,textarea", m).filter((e) => (e as HTMLInputElement).type !== "hidden" && vis(e) && !/select language/i.test(lab(e)));
}

const isDateSelect = (s: HTMLSelectElement) => {
  const first = (s.options[0]?.text || "").trim();
  const cur = (s.options[s.selectedIndex]?.text || "").trim();
  return /^(month|year)$/i.test(first) && (!s.value || /^(month|year)$/i.test(cur));
};

export function collectFields(): Collected {
  const m = modal();
  const fields: Field[] = [];
  const els = new Map<string, Control[]>();
  if (!m) return { fields, els };
  let n = 0;
  const add = (f: Omit<Field, "fid">, controls: Control[]) => {
    const fid = `f${n++}`;
    fields.push({ ...f, fid } as Field);
    els.set(fid, controls);
  };
  const all = controls(m);

  // Month/year selects with no label: education dates when the modal is about education, else the
  // current job's start (li_fill `dateFill`).
  const edu = /education|school|degree|field of study|dates attended/i.test(m.innerText || m.textContent || "");
  const dates = all.filter((e): e is HTMLSelectElement => e.tagName === "SELECT" && isDateSelect(e as HTMLSelectElement));
  dates.forEach((s, i) => {
    if (i > 3) return;
    add(
      {
        kind: "date_select", label: lab(s) && !/^(month|year)$/i.test(lab(s)) ? lab(s) : "", required: isRequired(s, lab(s)),
        options: [...s.options].map((o) => (o.text || "").trim()), option_values_empty: [...s.options].map((o) => !o.value),
        date: { part: /^year/i.test((s.options[0]?.text || "").trim()) ? "year" : "month", index: i, context: edu ? "education" : "experience" },
      },
      [s]
    );
  });

  for (const el of all) {
    const type = (el as HTMLInputElement).type;
    if (type === "radio" || type === "checkbox") continue;
    if (el.tagName === "SELECT") {
      const s = el as HTMLSelectElement;
      if (dates.includes(s)) continue;
      const cur = [...s.options].find((o) => o.value === s.value);
      if (s.value && cur && !PLACEHOLDER.test(cur.text || "")) continue; // already answered
      const L = lab(s);
      add({ kind: "select", label: clean(L), required: isRequired(s, L), options: [...s.options].map((o) => (o.text || "").trim()), option_values_empty: [...s.options].map((o) => !o.value) }, [s]);
      continue;
    }
    if ((el.value || "").trim()) continue; // already filled
    const L = lab(el);
    const typeahead = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list";
    const kind = el.tagName === "TEXTAREA" ? "textarea" : typeahead ? "typeahead" : type === "number" ? "number" : "text";
    const max = Number(el.getAttribute("maxlength")) || undefined;
    add({ kind, label: clean(L), required: isRequired(el, L), ...(max && max > 0 ? { max_length: max } : {}) }, [el]);
  }

  // Radio groups (li_dom `radios`): one question per name; an answered group is left alone.
  const groups = new Map<string, HTMLInputElement[]>();
  $$<HTMLInputElement>("input[type=radio]", m).forEach((e) => {
    const k = e.name || "x";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  });
  for (const list of groups.values()) {
    if (list.some((e) => e.checked)) continue;
    const q = qOf(list);
    add({ kind: "radio", label: q, required: list.some((e) => isRequired(e, q)) || /\*\s*$/.test(q), options: list.map(optText) }, list);
  }

  // Checkbox groups (a fieldset of two or more, none ticked), then lone boxes (li_fill).
  const boxes = $$<HTMLInputElement>("input[type=checkbox]", m).filter((e) => vis(e) || e.offsetParent !== null);
  const sets = new Map<Element, HTMLInputElement[]>();
  boxes.forEach((e) => {
    const fs = e.closest("fieldset");
    if (!fs) return;
    if (!sets.has(fs)) sets.set(fs, []);
    sets.get(fs)!.push(e);
  });
  const grouped = new Set<HTMLInputElement>();
  for (const [fs, list] of sets) {
    if (list.length < 2) continue;
    list.forEach((e) => grouped.add(e));
    if (list.some((e) => e.checked)) continue;
    const lg = fs.querySelector("legend");
    const q = (lg ? txt(lg) : txt(fs.previousElementSibling)).replace(/\*$/, "").slice(0, 500);
    const req = /\*\s*$/.test(lg ? txt(lg) : "") || Boolean(fs.querySelector("[aria-required=true],[required]"));
    add({ kind: "checkbox_group", label: q, required: req, options: list.map(optText) }, list);
  }
  for (const e of boxes) {
    if (grouped.has(e) || e.checked) continue;
    const L = `${lab(e)} ${optText(e)}`.replace(/\s+/g, " ").trim().slice(0, 500);
    add({ kind: "checkbox", label: L, required: isRequired(e, L) }, [e]);
  }
  return { fields, els };
}

export interface Applied {
  /** True when anything was set (the modal's own Save may then be needed). */
  changed: boolean;
  /** The typeahead that was given a value, to pick a suggestion for. */
  typeahead: { el: HTMLInputElement; value: string; label: string } | null;
}

/** Apply the server's actions to the fields they name. */
export function applyActions(c: Collected, actions: Action[]): Applied {
  let changed = false;
  let typeahead: Applied["typeahead"] = null;
  const kindOf = new Map(c.fields.map((f) => [f.fid, f]));
  for (const a of actions) {
    const f = kindOf.get(a.fid);
    const els = c.els.get(a.fid);
    if (!f || !els?.length) continue;
    if (a.do === "set") {
      const el = els[0] as HTMLInputElement | HTMLTextAreaElement;
      setVal(el, a.value);
      changed = true;
      if (f.kind === "typeahead" && !typeahead) typeahead = { el: el as HTMLInputElement, value: a.value, label: f.label };
    } else if (a.do === "choose") {
      if (f.kind === "select" || f.kind === "date_select") {
        const s = els[0] as HTMLSelectElement;
        const o = s.options[a.index];
        if (o) {
          setVal(s, o.value);
          changed = true;
        }
      } else {
        const box = els[a.index] as HTMLInputElement | undefined;
        if (box && !box.checked) {
          box.click();
          changed = true;
        }
      }
    } else if (a.do === "tick") {
      const box = els[0] as HTMLInputElement;
      if (!box.checked) {
        box.click();
        changed = true;
      }
    }
  }
  return { changed, typeahead };
}

/** One repair pass for a number field LinkedIn refused (li_fill `repair`): a decimal becomes a
    whole number (1 Oct: "Invalid input" for 0.5), a phrase with exactly one number becomes that
    number. Never the digits of a phrase glued together. */
export function repair(): boolean {
  const m = modal();
  if (!m) return false;
  let n = 0;
  for (const el of controls(m)) {
    if (el.tagName !== "INPUT") continue;
    let p: HTMLElement | null = el as HTMLElement, box: HTMLElement | null = null;
    for (let k = 0; k < 4 && p; k++) {
      p = p.parentElement;
      if (p && /invalid input|must be a (number|whole number|decimal)|enter a (valid|whole) number|larger than|smaller than|between \d/i.test(p.innerText || p.textContent || "")) {
        box = p;
        break;
      }
    }
    if (!box) continue;
    const v = (el.value || "").trim();
    if (/^\d+$/.test(v)) continue;
    let nv: string | null = null;
    if (/^\d+\.\d+$/.test(v)) nv = String(Math.round(+v));
    else {
      const nums = v.match(/\d+(?:\.\d+)?/g) ?? [];
      if (nums.length === 1) nv = /\./.test(nums[0]) ? String(Math.round(+nums[0])) : nums[0];
      else if (/^no$/i.test(v)) nv = "0";
    }
    if (!nv || nv === v) continue;
    setVal(el, nv);
    n++;
  }
  return n > 0;
}

/** The leaf error texts in the modal (required, invalid, must, enter a): up to 3, for a STALL. */
export function errorTexts(): string[] {
  const m = modal() || document.body;
  return $$("*", m)
    .filter((e) => e.children.length === 0 && /required|invalid|must|enter a/i.test(e.innerText || e.textContent || ""))
    .map((e) => (e.innerText || e.textContent || "").trim())
    .filter(Boolean)
    .slice(0, 3);
}
