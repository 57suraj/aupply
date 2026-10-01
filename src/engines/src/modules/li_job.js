/* LinkedIn apply 3/4: stepping through the form, and one job start to finish (job() opens
   the modal, cont() fills and advances until it is sent). */
function li_job(X) {
  'use strict';
  const { ME, P, sleep, txt, $$, vis, setVal, navBtn, modal, progress, clickText, deepAll, sentTo, dismiss, limitHit, applyControl, easy, closed, alreadyApplied, fill, repair } = X;

  // Polls until fn() answers or ms pass: the job page renders late, later still in a hidden tab.
  const until = async (fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v || Date.now() >= end) return v;
      await sleep(500);
    }
  };

  /* City typeaheads ("Enter city or location" on PyjamaHR and Greenhouse-backed forms) keep a
     typed value only once a suggestion is chosen; the old flow had Claude click it (applix
     amendment 45). Type the value again, wait for the suggestions, choose one that starts with
     it and names the user's country, the way a pointer does, and read the field back. false:
     Claude makes the real click (NEEDS_CLICK). A suggestion in another country is never picked. */
  const options = () => deepAll('[role=option]').filter(vis);
  const pick = async (el, v) => {
    const want = String(v).toLowerCase();
    const home = String(ME.country || '').toLowerCase();
    const matches = () => options().filter((o) => txt(o).toLowerCase().startsWith(want) && (!home || txt(o).toLowerCase().includes(home)));
    el.focus();
    setVal(el, '');
    setVal(el, String(v));
    ['keydown', 'keyup'].forEach((t) => el.dispatchEvent(new KeyboardEvent(t, { bubbles: true, key: String(v).slice(-1) })));
    const found = await until(() => (matches().length ? matches() : null), 4000);
    if (!found) return false;
    const o = found[0];
    const ev = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => o.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, ev) : new MouseEvent(t, ev)));
    await sleep(800);
    return (el.value || '').toLowerCase().startsWith(want) && el.getAttribute('aria-expanded') !== 'true' && !matches().length;
  };

  // "Follow <company>" is pre-ticked on the review page and its label is not linked by
  // label[for]: read the container text, click the label, verify.
  const ctxText = (e) => {
    const l = e.id ? document.querySelector('label[for="' + e.id + '"]') : null;
    let t = (l && l.innerText) || e.getAttribute('aria-label') || '';
    let p = e.parentElement;
    for (let i = 0; i < 4 && p && !/follow/i.test(t); i++) { t = (p.innerText || '') + ' ' + t; p = p.parentElement; }
    return t;
  };
  const unfollow = async () => {
    const r = [];
    for (const e of $$('input[type=checkbox]')) {
      if (!/follow .{0,60}(stay up to date|page)/i.test(ctxText(e))) continue;
      if (!e.checked) { r.push('off'); continue; }
      const l = e.id ? document.querySelector('label[for="' + e.id + '"]') : null;
      if (l) { l.click(); await sleep(300); }
      if (e.checked) { e.click(); await sleep(300); }
      if (e.checked) {
        const o = { bubbles: true, cancelable: true, view: window };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => (l || e).dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)));
        await sleep(300);
      }
      r.push(e.checked ? 'STILL' : 'off');
    }
    return r;
  };

  const cont = async () => {
    const trace = [], qa = [];
    let repaired = false;
    for (let i = 0; i < 12; i++) {
      let ta = null; // a typeahead the engine picked on this page
      if (!navBtn()) { trace.push('nomodal'); break; }
      const prev = progress();
      const f = fill();
      qa.push(...f.log);
      if (f.prot.length) return { result: 'PROTECTED', need: f.prot, trace, qa };
      // The modal's own Save (an edited section), never the job page's Save, which
      // bookmarks the job (1 Oct: every job the engine filled landed in Saved jobs).
      if (f.log.length) {
        const box = modal();
        const sv = box && $$('button', box).find((b) => /^save$/i.test(txt(b)) && !/\bjob\b|\bat\b/i.test(b.getAttribute('aria-label') || '') && !/jobs-save/.test(String(b.className || '')));
        if (sv) { sv.click(); await sleep(2000); }
      }
      if (f.typeahead) {
        ta = f.typeahead;
        if (!(await pick(ta.el, ta.v))) return { result: 'NEEDS_CLICK', need: [ta.need], rect: ta.rect, trace, qa };
      }
      const labels = $$('button').map(txt);
      const nxt = labels.find((x) => /^submit application$/i.test(x)) || labels.find((x) => /^review$/i.test(x)) || labels.find((x) => /^next$/i.test(x)) || labels.find((x) => /^continue$/i.test(x));
      trace.push(prev);
      if (f.un.length) return { result: 'NEEDS_INPUT', need: f.un, trace, qa };
      if (!nxt) return { result: 'NO_BUTTON', trace, qa };
      if (/^submit/i.test(nxt)) { const uf = await unfollow(); if (uf.includes('STILL')) return { result: 'FOLLOW_STUCK', trace, qa }; }
      clickText(nxt);
      await sleep(2800);
      if (/^submit/i.test(nxt)) break;
      if (prev && progress() === prev && navBtn()) {
        // Same page again: blocked, not slow. One repair pass, then report the stall.
        if (!repaired && repair()) { repaired = true; clickText(nxt); await sleep(2800); if (progress() !== prev) continue; }
        // A picked suggestion the form did not take: Claude makes the real click.
        if (ta) return { result: 'NEEDS_CLICK', need: [ta.need], rect: ta.rect, trace, qa };
        const errs = $$('*', modal() || document).filter((e) => e.children.length === 0 && /required|invalid|must|enter a/i.test(e.innerText || '')).map((e) => (e.innerText || '').trim()).slice(0, 3);
        return { result: 'STALL', errs, trace, qa };
      }
    }
    await sleep(2500);
    const who = sentTo();
    dismiss();
    return { result: who ? 'SENT' : 'UNCONFIRMED', trace, qa };
  };

  const job = async () => {
    if (closed()) return { result: 'CLOSED' };
    if (!navBtn()) {
      /* Judge a job only once its apply control has rendered, and call it NO_EASY_APPLY only
         when the company-site Apply is on screen: that verdict skips the job for good. With a
         fixed 3.5s wait a hidden tab read 5 of 12 Easy Apply jobs as no Easy Apply or no modal
         (1 Oct); the old runbook saw false NO_MODALs from a 7s wait. */
      const ctl = await until(() => applyControl() || (closed() && 'closed') || (alreadyApplied() && 'applied'), P.card);
      if (ctl === 'closed') return { result: 'CLOSED' };
      if (ctl === 'applied') return { result: 'ALREADY_APPLIED' };
      if (!ctl) return { result: 'NOT_LOADED' };
      if (!ctl.easy || !easy()) return { result: 'NO_EASY_APPLY' };
      await until(() => navBtn() || limitHit(), P.modal);
    }
    // The cap dialog: body text first (it is visible), shadow roots second.
    if (limitHit()) { const g = deepAll('button').find((b) => /^got it$/i.test(txt(b))); if (g) g.click(); return { result: 'DAILY_LIMIT' }; }
    if (!navBtn()) return { result: 'NO_MODAL' };
    return await cont();
  };

  return { cont, job, until };
}
