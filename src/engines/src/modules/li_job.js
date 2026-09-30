/* LinkedIn apply 3/4: stepping through the form, and one job start to finish (job() opens
   the modal, cont() fills and advances until it is sent). */
function li_job(X) {
  'use strict';
  const { sleep, txt, $$, navBtn, modal, progress, clickText, deepAll, sentTo, dismiss, limitHit, easy, closed, alreadyApplied, fill, repair } = X;

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
      if (!navBtn()) { trace.push('nomodal'); break; }
      const prev = progress();
      const f = fill();
      qa.push(...f.log);
      if (f.prot.length) return { result: 'PROTECTED', need: f.prot, trace, qa };
      if (f.log.length) { const sv = $$('button').find((b) => /^save$/i.test(txt(b))); if (sv) { sv.click(); await sleep(2000); } }
      if (f.typeahead) return { result: 'NEEDS_CLICK', need: [f.typeahead.need], rect: f.typeahead.rect, trace, qa };
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
      if (!easy()) return { result: alreadyApplied() ? 'ALREADY_APPLIED' : 'NO_EASY_APPLY' };
      await sleep(3500);
    }
    // The cap dialog: body text first (it is visible), shadow roots second.
    if (limitHit()) { const g = deepAll('button').find((b) => /^got it$/i.test(txt(b))); if (g) g.click(); return { result: 'DAILY_LIMIT' }; }
    if (!navBtn()) return { result: 'NO_MODAL' };
    return await cont();
  };

  return { cont, job };
}
