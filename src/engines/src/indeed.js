/* Aupply Indeed engine: draft (search result pages) and apply up to the review page,
   where a reCAPTCHA gates Submit. The engine NEVER touches the CAPTCHA: it parks the tab
   and the user submits. Ported from applix indeed-apply.js with amendments 21 to 26
   (Simplify hidden after every navigation, review-module means parked, radio questions
   read from the group's container, comboboxes left to a real click).
   Indeed spans in.indeed.com, www.indeed.com and smartapply.indeed.com; each origin
   caches the engine in its own localStorage after the first paste. */
(function boot(CFG) {
  'use strict';
  /*@include shared/core.js*/
  /*@include shared/resolver.js*/

  const KEY = '__aupply_indeed';
  const P = { step: 6000, maxSteps: 4 };
  const R = makeResolver(CFG, 'Indeed');
  const ST = makeStore(KEY + '_res_' + (CFG.u || 'x'), localStorage);
  const S = ST.S;
  S.running = false;
  const { status, wait } = makeStatus(CFG, ST);
  const SC = CFG.screen || {};
  try { localStorage.setItem(KEY, '(' + boot.toString() + ')(' + JSON.stringify(CFG) + ')'); } catch (e) { /* no cache */ }
  const lsGet = (k, d) => { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(KEY + k); else localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  // Simplify's "Add Custom Application" modal covers the form and is invisible to every
  // DOM read. Hide it, never dismiss it, after every navigation and every step.
  const kill = () => { let n = 0; document.querySelectorAll('.simplify-jobs-shadow-root,[class*="simplify" i]').forEach((e) => { e.style.setProperty('display', 'none', 'important'); n++; }); return n; };
  kill();
  if (!window.__aupplyKillObs) { window.__aupplyKillObs = new MutationObserver(kill); window.__aupplyKillObs.observe(document.documentElement, { childList: true, subtree: true }); }

  /* ---------------- draft ---------------- */
  const re = (src) => (src ? new RegExp(src, 'i') : null);
  const scrape = (first) => {
    const acc = first ? { rows: {}, drop: {}, pages: 0 } : lsGet('_draft', { rows: {}, drop: {}, pages: 0 });
    const NEGT = re(SC.negTitle), NEGS = re(SC.negStack), SPAM = re(SC.spam), POS = re(SC.pos);
    let cards = 0;
    const seen = new Set();
    // Cards repeat in the DOM: dedupe by jk.
    for (const c of $$('.job_seen_beacon, [data-testid="slider_item"]')) {
      const a = c.querySelector('a[data-jk], a[id^="job_"]');
      const jk = a ? (a.getAttribute('data-jk') || (a.id || '').replace('job_', '')).toLowerCase() : '';
      if (!/^[0-9a-f]{16}$/.test(jk) || seen.has(jk)) continue;
      seen.add(jk);
      cards++;
      const all = (c.innerText || '').replace(/\s+/g, ' ');
      const t = ((c.querySelector('[data-testid="jobTitle"]') || {}).innerText || (a ? a.getAttribute('aria-label') || '' : '')).replace(/^full details of /i, '').replace(/\s+/g, ' ').trim();
      const co = ((c.querySelector('[data-testid="company-name"]') || {}).innerText || '').trim();
      const sal = (all.match(/₹[\d,]+(?:\s*-\s*₹[\d,]+)?\s*a (?:month|year)/) || [])[0] || '';
      const pay = R.moneyRange(sal);
      let r = null;
      if (!/easily apply/i.test(all)) r = 'not_easy_apply';
      else if (SPAM && (SPAM.test(co) || SPAM.test(t))) r = 'company';
      else if (NEGT && NEGT.test(t)) r = 'title_seniority';
      else if (NEGS && (NEGS.test(t) || NEGS.test(co))) r = 'title_stack';
      else if (POS && !POS.test(t)) r = 'title_off_target';
      else if (pay && SC.minPay && pay[1] < SC.minPay) r = 'pay';
      if (r) { acc.drop[r] = (acc.drop[r] || 0) + 1; continue; }
      acc.rows[jk] = { id: jk, t: cut(t, 80), co: cut(co, 50), loc: cut(((c.querySelector('[data-testid="text-location"]') || {}).innerText || ''), 40), sal: cut(sal, 40) };
    }
    acc.pages++;
    lsSet('_draft', acc);
    return JSON.stringify({ page: acc.pages, cards, kept: Object.keys(acc.rows).length });
  };
  const draft = () => { const acc = lsGet('_draft', { rows: {}, drop: {}, pages: 0 }); lsSet('_draft', null); return JSON.stringify({ jobs: Object.values(acc.rows), dropped: acc.drop, pages: acc.pages }); };

  /* ---------------- wizard ---------------- */
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

  const rec = (id, r) => { const o = Object.assign({ id: String(id), a: aid() }, r); ST.push(o); return JSON.stringify(o); };

  /* Drive the wizard. On the job page it clicks "Apply with Indeed", which navigates to
     smartapply (the engine dies): paste or re-load there and call drive() again. On
     smartapply it walks at most 4 steps per call and stops at the review page. */
  const drive = async (id) => {
    kill();
    if (!/smartapply\.indeed\.com/.test(location.host)) {
      const start = $$('button,a').find((x) => /^apply with indeed$/i.test(txt(x)) || /^apply now$/i.test(txt(x)));
      if (!start) return rec(id, { r: /you'?ve applied|applied on/i.test(document.body.innerText) ? 'ALREADY' : 'NO_INDEED_APPLY' });
      start.click();
      return rec(id, { r: 'NAVIGATED' });
    }
    const trail = [];
    let qa = [];
    for (let i = 0; i < P.maxSteps; i++) {
      kill();
      const step = location.pathname.split('/').slice(-2).join('/');
      // review-module plus a CAPTCHA means parked, even when no Submit <button> exists.
      if (/review-module/.test(location.pathname)) {
        const sb = submitBtn();
        if (sb) sb.scrollIntoView({ block: 'center' });
        return rec(id, { r: captcha() || !sb || sb.disabled ? 'READY_FOR_CAPTCHA' : 'READY_TO_SUBMIT', step, qa });
      }
      // Two passes: ticking an attestation reveals a new required field.
      const f = fill();
      await sleep(600);
      const f2 = fill();
      qa = qa.concat(f.log, f2.log).slice(0, 16).map((p) => [cut(p[0], 70), cut(p[1], 40)]);
      trail.push(step);
      if (f2.prot.length) return rec(id, { r: 'PROTECTED', step, need: f2.prot, qa });
      if (f2.dropdowns.length) return rec(id, { r: 'NEEDS_DROPDOWN', step, need: f2.dropdowns, qa });
      if (f2.unknown.length) return rec(id, { r: 'NEEDS_INPUT', step, need: f2.unknown, qa });
      if (submitBtn()) return rec(id, { r: captcha() || submitBtn().disabled ? 'READY_FOR_CAPTCHA' : 'READY_TO_SUBMIT', step, qa });
      const c = contBtn();
      if (!c) return rec(id, { r: 'STUCK', step, qa });
      c.click();
      await sleep(P.step);
    }
    return rec(id, { r: 'CONTINUE', step: trail[trail.length - 1], qa });
  };

  const selfTest = () => { const fails = R.selfTest(); return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, h: CFG.h, platform: 'indeed', fails }); };

  window.__aupply = {
    v: CFG.v, h: CFG.h, platform: 'indeed',
    status, wait, running: () => !!S.running,
    all: () => JSON.stringify(ST.all()),
    scrape, draft, drive, jk: () => ((location.search.match(/[?&]v?jk=([a-f0-9]{16})/) || [])[1] || ''),
    selfTest, _t: { A: R.A, pickOpt: R.pickOpt },
  };
  return selfTest();
})(__AUPPLY_CFG__);
