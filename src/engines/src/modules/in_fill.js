/* Indeed 1/2: the result store, Simplify hiding and the wizard's form filler.
   Ported from applix indeed-apply.js with amendments 21 to 26 (Simplify hidden after
   every navigation, radio questions read from the group's container, comboboxes left to
   a real click). Indeed spans in.indeed.com, www.indeed.com and smartapply.indeed.com;
   each origin caches the engine in its own localStorage after the first load. */
function in_fill(X) {
  'use strict';
  const { CFG, R, txt, cut, makeStore, makeStatus } = X;
  const KEY = '__aupply_indeed';
  const P = { step: 6000, maxSteps: 4 };
  const ST = makeStore(KEY + '_res_' + (CFG.u || 'x'), localStorage);
  const S = ST.S;
  S.running = false;
  const { status, wait } = makeStatus(CFG, ST);
  const SC = CFG.screen || {};
  const lsGet = (k, d) => { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(KEY + k); else localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  // Simplify's "Add Custom Application" modal covers the form and is invisible to every
  // DOM read. Hide it, never dismiss it, after every navigation and every step.
  const kill = () => { let n = 0; document.querySelectorAll('.simplify-jobs-shadow-root,[class*="simplify" i]').forEach((e) => { e.style.setProperty('display', 'none', 'important'); n++; }); return n; };
  kill();
  if (!window.__aupplyKillObs) { window.__aupplyKillObs = new MutationObserver(kill); window.__aupplyKillObs.observe(document.documentElement, { childList: true, subtree: true }); }

  const ATTEST = /certif|attest|i agree|sign electronically|acknowledge|i understand|confirm that/i;
  const NEVER_TICK = /text message|sms|marketing|promotion|newsletter|updates about|notify me|follow/i;
  const contBtn = () => $$('button').find((x) => /^(continue|review your application)$/i.test(txt(x)));
  const submitBtn = () => $$('button').find((x) => /^submit your application$/i.test(txt(x)));
  const captcha = () => !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, iframe[title*="reCAPTCHA" i]');
  const fields = () => $$('input,textarea,select').filter((e) => e.type !== 'hidden' && e.offsetParent !== null);
  const labelOf = (e) => {
    if (e.labels && e.labels[0]) return e.labels[0].innerText.replace(/\s+/g, ' ').trim();
    let p = e.parentElement;
    for (let i = 0; i < 4 && p; i++) { const l = p.querySelector('label,legend'); if (l) return l.innerText.replace(/\s+/g, ' ').trim(); p = p.parentElement; }
    return (e.getAttribute('aria-label') || e.name || '').trim();
  };
  // Radio groups read their own first option as the question when no <label> wraps it:
  // walk previous siblings from the group's common container instead.
  const groupQ = (els) => {
    const fs = els[0].closest('fieldset');
    const lg = fs && fs.querySelector('legend');
    if (lg && txt(lg)) return txt(lg);
    let c = els[0];
    while (c.parentElement && !els.every((e) => c.contains(e))) c = c.parentElement;
    let p = c;
    for (let i = 0; i < 5 && p; i++) { if (p.previousElementSibling) { const x = txt(p.previousElementSibling); if (x) return x.replace(/\s*\*\s*$/, ''); } p = p.parentElement; }
    return labelOf(els[0]);
  };
  const setV = (el, v) => {
    const P2 = el.tagName === 'SELECT' ? HTMLSelectElement : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(P2.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const optLabel = (e) => ((e.closest('label') || e.parentElement || {}).innerText || '').trim();

  const fill = () => {
    const log = [], unknown = [], dropdowns = [], prot = [];
    const groups = {};
    for (const e of fields()) {
      if (e.type === 'radio') { (groups[e.name] = groups[e.name] || []).push(e); continue; }
      // Comboboxes (Country, currency, "how did you hear") are a display box plus a
      // search input with aria-controls. Writing to that input selects nothing and
      // empties a correctly prefilled field. Never touch it; a real click is needed.
      if (e.getAttribute('aria-controls')) {
        let w = e;
        for (let i = 0; i < 6 && w.parentElement; i++) w = w.parentElement;
        if (/select an option/i.test(w.innerText || '')) dropdowns.push(cut(labelOf(e), 50));
        continue;
      }
      if (e.type === 'checkbox') {
        const q = labelOf(e);
        if (ATTEST.test(q) && !NEVER_TICK.test(q) && !e.checked) { e.click(); log.push([q, 'ticked']); }
        continue;
      }
      if ((e.value || '').trim()) continue;   // prefilled from the Indeed profile
      const q = labelOf(e);
      const a = R.A(q);
      if (a && a.protected) { if (e.required) prot.push(cut(q, 100)); continue; }
      if (e.tagName === 'SELECT') {
        const texts = [...e.options].map((o) => (o.text || '').trim());
        let i = R.pickOpt(a, texts);
        if (i < 0) i = R.lowStakes(q, texts);
        if (i >= 0 && e.options[i].value) { setV(e, e.options[i].value); log.push([q, texts[i]]); } else if (e.required) unknown.push(cut(q, 80));
        continue;
      }
      const v = a ? (a.text != null ? a.text : a.v) : null;
      if (v != null && v !== '') { setV(e, String(v)); log.push([q, String(v)]); } else if (e.required) unknown.push(cut(q, 80));
    }
    for (const els of Object.values(groups)) {
      if (els.some((e) => e.checked)) continue;
      const q = groupQ(els);
      const texts = els.map(optLabel);
      const a = R.A(q);
      if (a && a.protected) { prot.push(cut(q, 100)); continue; }
      let i = R.pickOpt(a, texts);
      if (i < 0) i = R.lowStakes(q, texts);
      if (i >= 0) { els[i].click(); log.push([q, texts[i]]); } else unknown.push(cut(q, 80) + ' [' + texts.map((t) => cut(t, 14)).join('/') + ']');
    }
    return { log, unknown, dropdowns, prot };
  };

  return { P, ST, S, status, wait, SC, lsGet, lsSet, $$, kill, contBtn, submitBtn, captcha, fill };
}
