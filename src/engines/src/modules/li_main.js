/* LinkedIn apply 4/4: the queue runner (SPA navigation between jobs, 15 to 30s apart, a 5
   minute pause after "Rate Limited" and a stop on the second) and window.__aupply. */
function li_main(X) {
  'use strict';
  const { CFG, P, S, ST, R, OVER, norm, status, wait, sleep, jitter, cut, aid, txt, h31, deepAll, pageTitle, trackerCount, job, cont, until } = X;
  let pageWait = P.page;

  /* The run carries on in a hidden tab: the Chrome window behind the Claude app is the usual
     case, and core's sleep keeps its pace there. (1 Oct: a runner that waited for the tab to
     be shown sat paused until the user brought Chrome forward.) A result carries hid:1 when
     the tab was hidden at some point during that job, so a failure seen only in hidden tabs
     shows in the record. */
  let hidJob = false;
  let watching = false;
  const watchHidden = () => {
    if (watching) return;
    watching = true;
    document.addEventListener('visibilitychange', () => { if (document.hidden) hidJob = true; });
  };

  const nav = async (path) => {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    await sleep(pageWait);
  };
  // A job that makes no progress for P.jobMax ends the run as "stalled" (a frozen tab, or a
  // form that never moves): it is recorded, and the next job never starts while the stuck
  // one may still run.
  const withLimit = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ result: 'ERR', e: 'job_timeout' }), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
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
    // push() trims qa to what fits one answer (cut:1 says some were left out).
    if (res.qa && res.qa.length) rec.qa = res.qa.slice(0, 16).map((p) => [cut(p[0], 60), cut(p[1], 40)]);
    if (res.rect) { rec.rect = res.rect; rec.iw = window.innerWidth; }
    if (res.e) rec.e = res.e;
    if (hidJob) rec.hid = 1;
    return ST.push(rec);
  };

  // q: [[jobId, companyName], ...]. keepOpen: single job, leave the modal open for a
  // real-click handoff (NEEDS_CLICK, FOLLOW_STUCK), then resume(). k is the checksum of q
  // the server sent with it: a job id mistyped in transit would apply to the wrong job.
  // ov: [[question, answer], ...], the user's answers to an earlier NEEDS_INPUT. They ride in
  // the run block (covered by k) rather than in the config, so a retry never reloads the
  // engine: the config, and so the page's engine, stays the same.
  const runQueue = (q, opts) => {
    opts = opts || {};
    const ov = Array.isArray(opts.ov) ? opts.ov : [];
    if (opts.k != null && opts.k !== h31(JSON.stringify(ov.length ? [q, ov] : q))) return 'CORRUPT_QUEUE: copy the run block again exactly as given';
    if (S.running) return 'RUNNING';
    for (const p of ov) if (Array.isArray(p) && p.length === 2 && p[0]) OVER.set(norm(p[0]), String(p[1]));
    S.running = true; S.phase = 'applying'; S.stop = false; S.end = null; S.info = { tracker: {} };
    (async () => {
      let rl = 0, n = 0;
      try {
        S.info.tracker.before = await readTracker();
        watchHidden();
        for (const item of q) {
          if (S.stop) break;
          hidJob = document.hidden;
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
          // The title can trail the navigation, more so in a hidden tab (1 Oct: a TITLE_MISMATCH).
          const named = () => !co || (document.title || '').toLowerCase().includes(co.toLowerCase().slice(0, 6));
          if (!(await until(named, P.card))) {
            record(id, co, { result: 'TITLE_MISMATCH' });
          } else {
            let res;
            S.info.cur = id;
            try { res = await withLimit(job(), P.jobMax); } catch (e) { res = { result: 'ERR', e: cut(e && e.message, 100) }; }
            record(id, co, res);
            if (res.e === 'job_timeout') { S.end = 'stalled'; break; }
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
    runQueue, resume,
    stop: () => { S.stop = true; return 'stopping after the current job'; },
    tracker: trackerCount,
    selfTest, _t: { A: R.A, pickOpt: R.pickOpt },
  };
  return { ret: selfTest() };
}
