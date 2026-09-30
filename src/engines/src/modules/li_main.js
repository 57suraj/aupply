/* LinkedIn 4/4: the queue runner (SPA navigation between jobs, 15 to 30s apart, a 5
   minute pause after "Rate Limited" and a stop on the second) and window.__aupply. */
function li_main(X) {
  'use strict';
  const { CFG, P, S, ST, R, status, wait, sleep, jitter, cut, aid, txt, deepAll, pageTitle, trackerCount, job, cont, sweep, prescreen, yearsOf } = X;
  let pageWait = P.page;

  const nav = async (path) => {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    await sleep(pageWait);
  };
  const discard = async () => {
    const x = deepAll('button').find((b) => /^dismiss$/i.test(b.getAttribute('aria-label') || ''));
    if (x) { x.click(); await sleep(1200); }
    const d = deepAll('button').find((b) => /^discard$/i.test(txt(b)));
    if (d) { d.click(); await sleep(1200); }
  };
  const readTracker = async () => { if (!/jobs-tracker/.test(location.pathname)) await nav('/jobs-tracker/?stage=applied'); await sleep(1500); return trackerCount(); };
  const rateLimited = () => /rate limited/i.test(document.title || '');

  const record = (id, co, res) => {
    const pt = pageTitle();
    const rec = { id: String(id), r: res.result, t: pt.t, co: pt.co || cut(co, 40), a: aid() };
    if (res.need) rec.need = res.need.map((x) => cut(x, 120)).slice(0, 8);
    if (res.errs && res.errs.length) rec.errs = res.errs.map((x) => cut(x, 80));
    if (res.qa && res.qa.length) rec.qa = res.qa.slice(0, 16).map((p) => [cut(p[0], 70), cut(p[1], 40)]);
    if (res.rect) { rec.rect = res.rect; rec.iw = window.innerWidth; }
    if (res.e) rec.e = res.e;
    return ST.push(rec);
  };

  // q: [[jobId, companyName], ...]. keepOpen: single job, leave the modal open for a
  // real-click handoff (NEEDS_CLICK, FOLLOW_STUCK), then resume().
  const runQueue = (q, opts) => {
    opts = opts || {};
    if (S.running) return 'RUNNING';
    S.running = true; S.phase = 'applying'; S.stop = false; S.end = null; S.info = { tracker: {} };
    (async () => {
      let rl = 0, n = 0;
      try {
        S.info.tracker.before = await readTracker();
        for (const item of q) {
          if (S.stop) break;
          const id = String(item[0]), co = String(item[1] || '');
          await nav('/jobs/view/' + id + '/');
          if (rateLimited()) {
            rl++;
            ST.push({ id, r: 'RATE_LIMITED', n: rl, a: aid() });
            if (rl >= 2) { S.end = 'rate_limited'; break; }
            await sleep(P.rlPause);
            pageWait = P.pageSlow;
            await nav('/jobs/view/' + id + '/');
            if (rateLimited()) { ST.push({ id, r: 'RATE_LIMITED', n: 2, a: aid() }); S.end = 'rate_limited'; break; }
          }
          if (co && !(document.title || '').toLowerCase().includes(co.toLowerCase().slice(0, 6))) {
            record(id, co, { result: 'TITLE_MISMATCH' });
          } else {
            let res;
            try { res = await job(); } catch (e) { res = { result: 'ERR', e: cut(e && e.message, 100) }; }
            record(id, co, res);
            if (res.result === 'DAILY_LIMIT') { S.end = 'limit'; break; }
            if (!/^(SENT|UNCONFIRMED|CLOSED|NO_EASY_APPLY|ALREADY_APPLIED)$/.test(res.result) && !opts.keepOpen) await discard();
          }
          n++;
          if (opts.keepOpen) break;
          if (n % 10 === 0) S.info.tracker['after_' + n] = await readTracker();
          await sleep(jitter(P.gapMin, P.gapMax));
        }
        if (!opts.keepOpen) S.info.tracker.after = await readTracker();
      } catch (e) {
        ST.push({ r: 'ERR', e: cut(e && e.message, 100), a: aid() });
      }
      S.running = false;
      S.phase = S.end || 'done';
    })();
    return 'started';
  };

  const resume = (id) => {
    if (S.running) return 'RUNNING';
    S.running = true; S.phase = 'applying';
    (async () => {
      let res;
      try { res = await cont(); } catch (e) { res = { result: 'ERR', e: cut(e && e.message, 100) }; }
      record(id || '', '', res);
      S.running = false; S.phase = 'done';
    })();
    return 'started';
  };

  const selfTest = () => {
    const fails = R.selfTest();
    if (typeof history.pushState !== 'function') fails.push('history');
    return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, platform: 'linkedin', fails });
  };

  window.__aupply = {
    v: CFG.v, h: CFG.h, platform: 'linkedin',
    status, wait, running: () => !!S.running,
    all: () => JSON.stringify(ST.all()),
    sweep, prescreen, runQueue, resume,
    stop: () => { S.stop = true; return 'stopping after the current job'; },
    tracker: trackerCount,
    selfTest, _t: { A: R.A, pickOpt: R.pickOpt, yearsOf },
  };
  return { ret: selfTest() };
}
