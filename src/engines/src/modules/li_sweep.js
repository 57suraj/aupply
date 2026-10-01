/* LinkedIn draft 1/3: the sweep. sweep() searches the guest API (Easy Apply only, paced at
   one request a second) and keeps the titles that pass the screening rules. Only the draft
   engine loads it: applying never needs the screening code. */
function li_sweep(X) {
  'use strict';
  const { CFG, S, ST, P, sleep, clean, cut, aid, chunks, trackerCount } = X;
  const SC = CFG.screen || {};

  // DOMParser is neutered by Trusted Types, so the guest API HTML is parsed by regex.
  const parseCards = (t) => {
    const o = [];
    for (const ch of String(t || '').split(/<li[\s>]/)) {
      const u = /data-entity-urn="urn:li:jobPosting:(\d+)"/.exec(ch);
      if (!u) continue;
      const ti = /base-search-card__title"[^>]*>([\s\S]*?)<\//.exec(ch);
      const co = /base-search-card__subtitle"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(ch);
      const lo = /job-search-card__location"[^>]*>([\s\S]*?)<\//.exec(ch);
      o.push({ id: u[1], t: clean(ti && ti[1]), co: clean(co && co[1]), loc: clean(lo && lo[1]) });
    }
    return o;
  };
  const re = (src) => (src ? new RegExp(src, 'i') : null);
  // The server decides the searches: [keyword, window, pages], freshest window first.
  const TPR = { '1h': 'r3600', '24h': 'r86400', '1w': 'r604800' };
  const AGE = { '1h': 0, '24h': 1, '1w': 2 };

  const sweep = () => {
    if (S.running) return 'RUNNING';
    S.running = true; S.phase = 'sweeping'; S.info = {};
    (async () => {
      const map = new Map();
      let stop = null;
      const tracker = trackerCount();
      try {
        for (const s of SC.searches || []) {
          const kw = s[0], w = s[1];
          for (let p = 0; p < (s[2] || 1); p++) {
            const u = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
            u.searchParams.set('keywords', kw);
            u.searchParams.set('location', SC.location || 'India');
            if (SC.geoId) u.searchParams.set('geoId', SC.geoId);
            u.searchParams.set('f_TPR', TPR[w] || 'r86400');
            u.searchParams.set('f_AL', 'true');
            u.searchParams.set('sortBy', 'DD');
            u.searchParams.set('start', String(p * 10));
            let st = 0, body = '';
            try { const r = await fetch(u.toString(), { credentials: 'include' }); st = r.status; body = r.ok ? await r.text() : ''; } catch (e) { st = -1; }
            if (st === 429 || st === 999) { stop = 'rate_limited_search'; break; }
            const cards = parseCards(body);
            for (const j of cards) if (!map.has(j.id)) { j.w = w; map.set(j.id, j); }
            await sleep(P.search);
            if (cards.length < 10) break; // no further pages for this search
          }
          if (stop) break;
        }
        const NEGT = re(SC.negTitle), NEGS = re(SC.negStack), POS = re(SC.pos), SPAM = re(SC.spam), AGG = re(SC.agg);
        const YT = /(\d{1,2})\s*\+?\s*(?:yoe|yrs?|years?)\b/i;
        const dropped = {};
        const keep = [];
        for (const j of map.values()) {
          let r = null;
          const y = YT.exec(j.t);
          if (NEGT && NEGT.test(j.t)) r = 'title_seniority';
          else if (NEGS && (NEGS.test(j.t) || NEGS.test(j.co))) r = 'title_stack';
          else if (SPAM && SPAM.test(j.co)) r = 'company';
          else if (POS && !POS.test(j.t)) r = 'title_off_target';
          else if (y && SC.maxYears != null && +y[1] > SC.maxYears) r = 'title_years';
          if (r) { dropped[r] = (dropped[r] || 0) + 1; continue; }
          j.agg = AGG && AGG.test(j.co) ? 1 : 0;
          keep.push(j);
        }
        // Job-ad networks last (they land but never reply), the freshest postings first.
        keep.sort((a, b) => a.agg - b.agg || AGE[a.w] - AGE[b.w]);
        S.cand = keep;
        // The ids in chunks that fit one answer, then the summary with done:1.
        const ids = keep.map((j) => j.id);
        for (const part of chunks(ids, 600)) ST.push({ phase: 'swept', ids: part, a: aid() });
        ST.push(Object.assign({ phase: 'swept', done: 1, n: ids.length, found: map.size, dropped, tracker, a: aid() }, stop ? { stop } : {}));
      } catch (e) {
        ST.push({ phase: 'swept', done: 1, n: 0, error: cut(e && e.message, 100), a: aid() });
      }
      S.running = false; S.phase = 'swept';
    })();
    return 'started';
  };

  return { sweep };
}
