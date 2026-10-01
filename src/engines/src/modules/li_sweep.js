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

  const sweep = () => {
    if (S.running) return 'RUNNING';
    S.running = true; S.phase = 'sweeping'; S.info = {};
    (async () => {
      const map = new Map();
      let stop = null;
      const tracker = trackerCount();
      try {
        for (const w of SC.windows || ['r3600', 'r86400']) {
          for (const kp of SC.keywords || []) {
            for (let p = 0; p < (kp[1] || 1); p++) {
              const u = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
              u.searchParams.set('keywords', kp[0]);
              u.searchParams.set('location', SC.location || 'India');
              if (SC.geoId) u.searchParams.set('geoId', SC.geoId);
              u.searchParams.set('f_TPR', w);
              u.searchParams.set('f_AL', 'true');
              u.searchParams.set('sortBy', 'DD');
              u.searchParams.set('start', String(p * 10));
              let st = 0, body = '';
              try { const r = await fetch(u.toString(), { credentials: 'include' }); st = r.status; body = r.ok ? await r.text() : ''; } catch (e) { st = -1; }
              if (st === 429 || st === 999) { stop = 'rate_limited_search'; break; }
              const cards = parseCards(body);
              for (const j of cards) if (!map.has(j.id)) { j.w = w === 'r3600' ? '1h' : '24h'; map.set(j.id, j); }
              await sleep(P.search);
              if (cards.length < 10) break; // no further pages for this keyword
            }
            if (stop) break;
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
        // Job-ad networks last (they land but never reply), last-hour postings first.
        keep.sort((a, b) => a.agg - b.agg || (a.w === '1h' ? 0 : 1) - (b.w === '1h' ? 0 : 1));
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
