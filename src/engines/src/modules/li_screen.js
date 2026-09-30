/* LinkedIn draft 2/3: the prescreen. prescreen() reads each job description (1.5s apart, a
   10 minute pause on the first 429, a stop on the second) and keeps the best ones. */
function li_screen(X) {
  'use strict';
  const { CFG, S, ST, P, payMax, sleep, clean, cut, aid } = X;
  const SC = CFG.screen || {};

  // Years from the FIRST match that reads as an experience requirement; matches in a
  // recruiter byline ("25+ yrs in Tech") or with no "experience" nearby are skipped. An
  // uncertain match never drops a job.
  const YRS = /(?<![\d.])(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:-|to|–)?\s*(\d{0,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)\b/gi;
  const BYLINE = /\bin (tech|technology|recruit\w*|hiring|hr|talent|staffing|the industry|business)\b|founded|since \d{4}|we'?ve been|over the (last|past)|years? (ago|old)|anniversary|history|legacy|trusted by/i;
  const EXPN = /experien|\bexp\b|yoe|background|hands.?on|track record|working (in|with|on)/i;
  const yearsOf = (t) => {
    YRS.lastIndex = 0;
    let m, first = null;
    while ((m = YRS.exec(t))) {
      const ctx = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      if (!first) first = m;
      if (EXPN.test(ctx) && !BYLINE.test(ctx)) return { minY: parseFloat(m[1]) };
    }
    return first ? { minY: parseFloat(first[1]), yu: 1 } : { minY: null };
  };
  const jd = async (id) => {
    let r, h = '';
    try { r = await fetch('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + id, { credentials: 'include' }); h = r.ok ? await r.text() : ''; } catch (e) { return { v: 'ERR' }; }
    // An empty body is a rate limit, not "no years stated".
    if (r.status === 429 || r.status === 999 || (r.ok && !h.trim())) return { v: 'RATE_LIMITED' };
    if (!r.ok) return { v: 'HTTP_' + r.status };
    const t = clean(h);
    if (/no longer accepting applications/i.test(t)) return { v: 'CLOSED' };
    const ats = (h.match(/applicantTrackingSystemName(?:=|%3D|"\s*:\s*")([A-Za-z]+)/) || [])[1];
    if (ats && !/linkedin/i.test(ats)) return { v: 'DROP_ATS' };
    if (SC.jdExclude && new RegExp(SC.jdExclude, 'i').test(t)) return { v: 'DROP_JD_EXCLUDE' };
    const lvl = (t.match(/Seniority level\s*(Internship|Entry level|Associate|Mid-Senior level|Director|Executive|Not Applicable)/i) || [])[1] || null;
    const y = yearsOf(t);
    if (y.minY != null && !y.yu && SC.maxYears != null && y.minY > SC.maxYears) return { v: 'DROP_YEARS' };
    if (y.minY == null && SC.skipMidSenior && /mid-senior|director|executive/i.test(lvl || '')) return { v: 'DROP_MIDSENIOR' };
    const pay = payMax(t);
    if (pay != null && SC.minPay && pay < SC.minPay) return { v: 'DROP_PAY' };
    const sm = (SC.stack || []).filter((s) => new RegExp(s[1], 'i').test(t)).map((s) => s[0]);
    return { v: 'keep', minY: y.minY, yu: y.yu, lvl: lvl && !/not applicable/i.test(lvl) ? lvl : null, pay, sm };
  };

  // o.skip: ids check_applied already knows. o.only: restrict to these ids.
  const prescreen = (o) => {
    o = o || {};
    if (S.running) return 'RUNNING';
    if (!S.cand || !S.cand.length) return 'NO_CANDIDATES: run sweep() in this page first';
    const skip = new Set((o.skip || []).map(String));
    const only = o.only ? new Set(o.only.map(String)) : null;
    const list = S.cand.filter((j) => !skip.has(j.id) && (!only || only.has(j.id)));
    const target = +(o.target || SC.target || 40);
    S.running = true; S.phase = 'screening'; S.info = {};
    (async () => {
      const keep = [], drop = [];
      let hits = 0, stop = null;
      try {
        for (const j of list) {
          if (keep.length >= target) break;
          let rec = await jd(j.id);
          if (rec.v === 'RATE_LIMITED') {
            // First 429: wait 10 minutes and resume. Second: end the prescreen.
            hits++;
            if (hits >= 2) { stop = 'rate_limited_jd'; break; }
            S.info.paused_until = new Date(Date.now() + P.jdPause).toISOString();
            await sleep(P.jdPause);
            delete S.info.paused_until;
            rec = await jd(j.id);
            if (rec.v === 'RATE_LIMITED') { stop = 'rate_limited_jd'; break; }
          }
          if (rec.v === 'keep') {
            const k = { id: j.id, t: cut(j.t, 80), co: cut(j.co, 50), loc: cut(j.loc, 40), w: j.w };
            if (j.agg) k.agg = 1;
            if (rec.minY != null) k.minY = rec.minY;
            if (rec.yu) k.yu = 1;
            if (rec.lvl) k.lvl = rec.lvl;
            if (rec.pay) k.pay = rec.pay;
            if (rec.sm && rec.sm.length) k.sm = rec.sm;
            keep.push(k);
          } else if (!/^(HTTP|ERR)/.test(rec.v)) {
            drop.push({ id: j.id, r: rec.v, t: cut(j.t, 60), co: cut(j.co, 40) });
          }
          await sleep(P.jd);
        }
      } catch (e) {
        stop = 'error: ' + cut(e && e.message, 80);
      }
      ST.push(Object.assign({ phase: 'screened', keep, drop, a: aid() }, stop ? { stop } : {}));
      S.running = false; S.phase = 'screened';
    })();
    return 'started';
  };

  return { prescreen, yearsOf };
}
