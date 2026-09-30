/* Naukri 2/2: apply (one click or the chatbot, 15 to 30s apart across page loads), the
   draft scrape of search result pages, and window.__aupply. */
function nk_main(X) {
  'use strict';
  const { CFG, R, sleep, jitter, txt, cut, aid, P, ST, S, status, wait, SC, lsGet, lsSet, kill, code, chat, unfollow } = X;

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

  const selfTest = () => { const fails = R.selfTest(); return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, platform: 'naukri', fails }); };

  window.__aupply = {
    v: CFG.v, h: CFG.h, platform: 'naukri',
    status, wait, running: () => !!S.running,
    all: () => JSON.stringify(ST.all()),
    scrape, draft, go, finish,
    selfTest, _t: { A: R.A, pickOpt: R.pickOpt },
  };
  return { ret: selfTest() };
}
