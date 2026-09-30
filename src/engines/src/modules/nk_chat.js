/* Naukri 1/2: the result store, Simplify hiding and the recruiter chatbot.
   Ported from applix naukri-auto-apply.js and naukri-sweep.js with the fixes recorded in
   the amendments (leaf Save button, repeated-question guard, academic ladders fail safe,
   "Follow" unticked, company screening). Naukri allows eval, so after the first load the
   engine caches itself in localStorage and later pages re-load it from there. */
function nk_chat(X) {
  'use strict';
  const { CFG, ME, R, sleep, cut, makeStore, makeStatus } = X;
  const KEY = '__aupply_naukri';
  const P = { gapMin: 15000, gapMax: 30000, pollTries: 16, pollMs: 800, afterClick: 6500, step: 3800, maxSteps: 14 };
  const ST = makeStore(KEY + '_res_' + (CFG.u || 'x'), localStorage);
  const S = ST.S;
  S.running = false;
  const { status, wait } = makeStatus(CFG, ST);
  const SC = CFG.screen || {};
  const lsGet = (k, d) => { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(KEY + k); else localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  /* Simplify must be HIDDEN, never dismissed: dismissing its modal aborts Naukri's
     apply flow and produces a 406. */
  const kill = () => document.querySelectorAll('.simplify-jobs-shadow-root').forEach((e) => e.style.setProperty('display', 'none', 'important'));
  kill();
  if (!window.__aupplyKillObs) { window.__aupplyKillObs = new MutationObserver(kill); window.__aupplyKillObs.observe(document.documentElement, { childList: true, subtree: true }); }

  const click = (el) => {
    if (!el) return false;
    try { el.click(); } catch (e) { /* ignore */ }
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) { try { el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)); } catch (e) { /* ignore */ } }
    return true;
  };
  // Free text: select-all + delete first (or "1" twice becomes "11"), then execCommand;
  // a native value setter never reaches React here.
  const typeInto = (box, text) => {
    box.focus();
    const sel = window.getSelection(), rng = document.createRange();
    rng.selectNodeContents(box);
    sel.removeAllRanges();
    sel.addRange(rng);
    if (box.textContent) document.execCommand('delete', false);
    return document.execCommand('insertText', false, text);
  };
  // The chatbot's Save is a leaf div.sendMsg inside a container whose text is also
  // "Save"; clicking the container does nothing. The job card's "Saved" must not match.
  const saveBtn = () => [...document.querySelectorAll('button,div.sendMsg')].find((b) => /^save$/i.test((b.innerText || '').trim()) && b.offsetParent !== null && b.children.length === 0);
  const submit = () => {
    const sb = saveBtn();
    if (sb && !sb.disabled) { click(sb); return 'save'; }
    const box = document.querySelector('[id^="userInput__"]');
    if (box) { for (const ty of ['keydown', 'keypress', 'keyup']) box.dispatchEvent(new KeyboardEvent(ty, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); return 'enter'; }
    return 'none';
  };
  // Read the question inside the chat panel only; Naukri's footer corrupts body text.
  const NOISE = /kindly answer all the recruiter'?s questions[^.]*\.|hi [a-z]+, thank you for showing interest\.?/gi;
  const chatRoot = () => { let n = document.querySelector('[id^="userInput__"]') || saveBtn(); for (let i = 0; i < 8 && n; i++) { n = n.parentElement; if (n && (n.innerText || '').length > 60) return n; } return document.body; };
  const currentQ = () => {
    const t = (chatRoot().innerText || '').replace(/\s+/g, ' ').replace(NOISE, ' ').trim();
    const qs = t.match(/[^.?!]{6,200}\?/g) || [];
    if (qs.length) { let q = qs[qs.length - 1].trim(); const c = q.lastIndexOf('. '); if (c > -1) q = q.slice(c + 2); return q.slice(-160); }
    const b = document.querySelector('[id^="userInput__"]');
    if (b) { let p = b; for (let i = 0; i < 6 && p; i++) { p = p.parentElement; const x = ((p && p.innerText) || '').replace(/\s+/g, ' ').trim(); if (x && x.length < 140) return x; } }
    return '';
  };
  const options = () => [...document.querySelectorAll('input[type=radio],input[type=checkbox]')].filter((e) => e.offsetParent !== null && !e.closest('[class*="fb_ckb_container"]')).map((e) => ({ el: e, label: ((e.nextElementSibling && e.nextElementSibling.innerText) || (e.parentElement && e.parentElement.innerText) || '').trim() }));

  // Academic ladders fail safe until the chatbot reads the newest bubble instead of the
  // last "?" (a question without "?" can re-send the previous answer). No answer means
  // Naukri times the chat out into a 406, and a 406 creates no application.
  const ACADEMIC = /s\.?s\.?c\b|\b10th\b|matric|h\.?s\.?c\b|\b12th\b|intermediate|senior secondary|diploma|(graduation|\bug\b|\bpg\b|b\.?tech|b\.?e\b|bachelor|master).{0,24}(percentage|cgpa|gpa|marks|score)/i;
  const answerFor = (q) => {
    const s = String(q || '').toLowerCase();
    if (ACADEMIC.test(s)) return { skip: 'academic' };
    // Relocates anywhere: tick every city offered.
    if (/preferred (work )?location|willing to relocate to|which (of these )?(cities|locations)|base location|city you are/.test(s) && ME.relocate !== false) return { a: { k: 'relocate.cities', v: 'Yes', yn: 'yes' }, text: ME.city || 'Yes', all: true };
    const a = R.A(q);
    if (a && a.protected) return { skip: 'protected' };
    if (a && a.v != null) {
      let text = a.text != null ? a.text : a.v;
      if (a.k === 'notice.days') text = a.v + ' days';
      // Naukri asks CTC in lakhs unless the question says rupees.
      if ((a.k === 'comp.current' || a.k === 'comp.expected') && a.money != null && !/rupee|\binr\b|₹|per annum in rs/.test(s)) text = R.lakhs(a.money);
      return { a, text };
    }
    if (/do you have|have you|are you|can you|willing|comfortable|any experience/.test(s)) return { a: { k: 'generic.yes', v: 'Yes', yn: 'yes' }, text: 'Yes' };
    return null;
  };

  let lastQ = '';
  const waitAnswerable = async (tries) => {
    for (let i = 0; i < (tries || 14); i++) {
      kill();
      const opts = options();
      const q = currentQ();
      // Never answer the same question text twice running (amendment 4, fix 1).
      if (q && q === lastQ && !opts.length) { await sleep(900); continue; }
      if (opts.length) {
        if (q && q !== lastQ) { const f = answerFor(q); if (f) return { q, f, opts }; }
        // Options can render before their question: Yes after five polls (applix).
        if (i > 5 && opts.some((o) => /^yes/i.test(o.label))) return { q: q || '(blank)', f: { a: { k: 'generic.yes', v: 'Yes', yn: 'yes' }, text: 'Yes' }, opts };
      } else if (q && q !== lastQ) {
        const f = answerFor(q);
        if (f) return { q, f, opts: [] };
      }
      await sleep(900);
    }
    return null;
  };

  const code = () => { const m = location.href.match(/multiApplyResp=([^&]*)/); if (!m) return null; const n = (decodeURIComponent(m[1]).match(/:\s*(\d{3})/) || [])[1]; return n ? +n : null; };

  const chat = async () => {
    const qa = [];
    for (let step = 0; step < P.maxSteps; step++) {
      kill();
      const c = code();
      if (c) return { r: c === 200 ? 'APPLIED' : 'REJECTED', code: c, qa };
      const w = await waitAnswerable();
      if (!w) return { r: 'NO_ANSWERABLE_QUESTION', q: cut(currentQ(), 120), qa };
      const { q, f } = w;
      if (f.skip) return { r: 'NO_ANSWER', why: f.skip, q: cut(q, 120), qa };
      const opts = options();
      if (opts.length) {
        let t = [];
        if (f.all) t = opts.filter((o) => !/^skip/i.test(o.label));
        else { const i = R.pickOpt(f.a, opts.map((o) => o.label)); if (i >= 0) t = [opts[i]]; }
        if (!t.length && f.a && f.a.yn === 'yes') t = opts.filter((o) => /^yes/i.test(o.label)).slice(0, 1);
        // No blind "first option": that is how false facts reach an application.
        if (!t.length) return { r: 'NO_ANSWER', why: 'no_matching_option', q: cut(q, 120), opts: opts.map((o) => cut(o.label, 30)).slice(0, 8), qa };
        t.forEach((x) => { if (!x.el.checked) click(x.el); });
        const got = t.filter((x) => x.el.checked).map((x) => x.label);
        if (!got.length) return { r: 'CLICK_FAILED', q: cut(q, 120), qa };
        qa.push([cut(q, 70), cut(got.join(', '), 40)]);
      } else {
        const box = document.querySelector('[id^="userInput__"]');
        if (!box) return { r: 'NO_INPUT', q: cut(q, 120), qa };
        if (!typeInto(box, String(f.text))) return { r: 'TYPE_FAILED', q: cut(q, 120), qa };
        qa.push([cut(q, 70), cut(f.text, 40)]);
      }
      lastQ = q;
      await sleep(700);
      submit();
      await sleep(P.step);
    }
    return { r: 'MAX_STEPS', qa };
  };

  // Naukri pre-ticks "Follow <Company> as you apply"; a JS click on its icon unticks it.
  const unfollow = () => {
    const c = document.querySelector('[class*="fb_ckb_container"]');
    if (!c) return;
    const inp = c.querySelector('input[type=checkbox]');
    const on = inp ? inp.checked : /checked|active|selected/.test(c.className + ' ' + ((c.querySelector('i') || {}).className || ''));
    if (on) click(c.querySelector('i') || c);
  };

  return { P, ST, S, status, wait, SC, lsGet, lsSet, kill, code, chat, unfollow };
}
