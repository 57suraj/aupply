/* Indeed 2/2: the draft scrape, the wizard driver and window.__aupply. The engine NEVER
   touches the reCAPTCHA on the review page: it parks the tab and the user submits. */
function in_main(X) {
  'use strict';
  const { CFG, R, sleep, txt, cut, aid, P, ST, S, status, wait, SC, lsGet, lsSet, $$, kill, contBtn, submitBtn, captcha, fill } = X;

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

  const rec = (id, r) => { const o = Object.assign({ id: String(id), a: aid() }, r); ST.push(o); return JSON.stringify(o); };

  /* Drive the wizard. On the job page it clicks "Apply with Indeed", which navigates to
     smartapply (the engine dies): load it there and call drive() again. On smartapply
     it walks at most 4 steps per call and stops at the review page. */
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

  const selfTest = () => { const fails = R.selfTest(); return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, platform: 'indeed', fails }); };

  window.__aupply = {
    v: CFG.v, h: CFG.h, platform: 'indeed',
    status, wait, running: () => !!S.running,
    all: () => JSON.stringify(ST.all()),
    scrape, draft, drive, jk: () => ((location.search.match(/[?&]v?jk=([a-f0-9]{16})/) || [])[1] || ''),
    selfTest, _t: { A: R.A, pickOpt: R.pickOpt },
  };
  return { ret: selfTest() };
}
