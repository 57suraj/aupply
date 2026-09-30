/* Aupply Naukri engine: draft (scrape search result pages) and apply (one click or the
   recruiter chatbot). Ported from applix naukri-auto-apply.js and naukri-sweep.js with
   the fixes recorded in the amendments (leaf Save button, repeated-question guard,
   academic ladders fail safe, "Follow" unticked, company screening).
   Naukri allows eval, so after the first paste the engine caches itself in
   localStorage and later pages re-load it with one line. */
(function boot(CFG) {
  'use strict';
  /*@include shared/core.js*/
  /*@include shared/resolver.js*/

  const KEY = '__aupply_naukri';
  const P = { gapMin: 15000, gapMax: 30000, pollTries: 16, pollMs: 800, afterClick: 6500, step: 3800, maxSteps: 14 };
  const R = makeResolver(CFG, 'Naukri');
  const ST = makeStore(KEY + '_res_' + (CFG.u || 'x'), localStorage);
  const S = ST.S;
  S.running = false;
  const { status, wait } = makeStatus(CFG, ST);
  const SC = CFG.screen || {};
  const ME = CFG.me || {};
  try { localStorage.setItem(KEY, '(' + boot.toString() + ')(' + JSON.stringify(CFG) + ')'); } catch (e) { /* no cache */ }
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

  const finishRec = (id, res) => {
    lsSet('_pending', null);
    return ST.push(Object.assign({ id: String(id), a: aid() }, res));
  };

  /* Apply to the job on this page. Waits out the 15-30s gap since the previous
     application (enforced across page loads), polls 13s for the Apply control and
     branches on its label. One-click applies navigate away at once; chatbot applies
     navigate when the chat ends. Either way finish() on the next page reads the code. */
  const go = async (id) => {
    if (S.running) return JSON.stringify({ r: 'RUNNING' });
    const gap = lsGet('_next', 0) - Date.now();
    if (gap > 30000) return JSON.stringify({ r: 'WAIT', ms: gap });
    if (gap > 0) await sleep(gap);
    kill();
    let b = null;
    for (let i = 0; i < P.pollTries; i++) {
      b = [...document.querySelectorAll('button,a')].find((x) => x.offsetParent !== null && /^(apply|applied|apply on company site)$/i.test(txt(x)));
      if (b) break;
      await sleep(P.pollMs);
    }
    if (!b) return JSON.stringify(finishRec(id, { r: 'NO_APPLY_BUTTON' }));
    const label = txt(b);
    if (/^applied$/i.test(label)) return JSON.stringify(finishRec(id, { r: 'ALREADY' }));
    if (/company site/i.test(label)) return JSON.stringify(finishRec(id, { r: 'EXTERNAL' }));
    lsSet('_pending', { id: String(id), at: Date.now() });
    lsSet('_next', Date.now() + jitter(P.gapMin, P.gapMax));
    unfollow();
    S.running = true; S.phase = 'applying';
    (async () => {
      let res;
      try {
        b.click();
        await sleep(P.afterClick);
        kill();
        const c = code();
        res = c ? { r: c === 200 ? 'APPLIED' : 'REJECTED', code: c } : await chat();
      } catch (e) { res = { r: 'ERR', e: cut(e && e.message, 100) }; }
      if (res) finishRec(id, res);
      S.running = false; S.phase = 'done';
    })();
    return JSON.stringify({ r: 'STARTED', id: String(id) });
  };

  // After the page navigated (or to wait on a running chat): record the redirect code
  // for the pending job, then return what is new.
  const finish = async (ms) => {
    const end = Date.now() + Math.min(+ms || 30000, 40000);
    for (;;) {
      const pend = lsGet('_pending', null);
      const c = code();
      if (pend && c) finishRec(pend.id, { r: c === 200 ? 'APPLIED' : 'REJECTED', code: c });
      else if (pend && !S.running && Date.now() - pend.at > 180000) finishRec(pend.id, { r: 'NO_RESULT' });
      if (!lsGet('_pending', null) || Date.now() > end) break;
      await sleep(1000);
    }
    return status();
  };

  /* Draft: run on each search results page in turn. Kept rows accumulate in
     localStorage across pages; draft() returns them all. */
  const re = (src) => (src ? new RegExp(src, 'i') : null);
  const scrape = (first) => {
    const acc = first ? { rows: {}, drop: {}, pages: 0 } : lsGet('_draft', { rows: {}, drop: {}, pages: 0 });
    const NEGT = re(SC.negTitle), NEGS = re(SC.negStack), SPAM = re(SC.spam), EXT = re(SC.external), POS = re(SC.pos);
    const cards = [...document.querySelectorAll('.srp-jobtuple-wrapper')];
    for (const w of cards) {
      const a = w.querySelector('a.title');
      const href = a ? a.getAttribute('href') || '' : '';
      const id = w.getAttribute('data-job-id') || (href.match(/-(\d{10,14})(?:[/?#]|$)/) || [])[1] || '';
      if (!id) continue;
      const j = { id, t: txt(a), co: txt(w.querySelector('a.comp-name')), ex: txt(w.querySelector('.expwdth')), sal: txt(w.querySelector('.sal-wrap')), loc: txt(w.querySelector('.locWdth')) };
      const exMin = (j.ex.match(/(\d{1,2})\s*-\s*(\d{1,2})/) || [])[1];
      const pay = R.moneyRange(j.sal);
      let r = null;
      if (id.slice(6, 8) === '50') r = 'external_series';   // 12 of 12 were "Apply on company site"
      else if (EXT && EXT.test(j.co)) r = 'external_company';
      else if (SPAM && (SPAM.test(j.co) || SPAM.test(j.t))) r = 'company';
      else if (NEGT && NEGT.test(j.t)) r = 'title_seniority';
      else if (NEGS && (NEGS.test(j.t) || NEGS.test(j.co))) r = 'title_stack';
      else if (POS && !POS.test(j.t)) r = 'title_off_target';
      else if (/unpaid/i.test(j.sal)) r = 'pay';
      else if (pay && SC.minPay && pay[1] < SC.minPay) r = 'pay';
      else if (exMin != null && SC.maxYears != null && +exMin > SC.maxYears) r = 'years';
      if (r) { acc.drop[r] = (acc.drop[r] || 0) + 1; continue; }
      acc.rows[id] = { id, t: cut(j.t, 80), co: cut(j.co, 50), ex: cut(j.ex, 20), sal: cut(j.sal, 40), loc: cut(j.loc, 40) };
    }
    acc.pages++;
    lsSet('_draft', acc);
    return JSON.stringify({ page: acc.pages, cards: cards.length, kept: Object.keys(acc.rows).length });
  };
  const draft = () => { const acc = lsGet('_draft', { rows: {}, drop: {}, pages: 0 }); lsSet('_draft', null); return JSON.stringify({ jobs: Object.values(acc.rows), dropped: acc.drop, pages: acc.pages }); };

  const selfTest = () => { const fails = R.selfTest(); return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, h: CFG.h, platform: 'naukri', fails }); };

  window.__aupply = {
    v: CFG.v, h: CFG.h, platform: 'naukri',
    status, wait, running: () => !!S.running,
    all: () => JSON.stringify(ST.all()),
    scrape, draft, go, finish,
    selfTest, _t: { A: R.A, pickOpt: R.pickOpt },
  };
  return selfTest();
})(__AUPPLY_CFG__);
