/* Aupply LinkedIn engine: Easy Apply drafting and applying.
   Ported from applix 05-SCRIPTS-linkedin-engine.js (30 Sep 2026, live-tested) with the
   personal values moved to CFG and the answer chain replaced by the shared resolver.
   Paste it once on /jobs-tracker/ (never eval: LinkedIn's CSP blocks eval on job pages,
   and on the tracker page after the first load). The runner then moves between jobs by
   SPA navigation, so the page, and this engine, stay alive for the whole queue. */
(function boot(CFG) {
  'use strict';
  /*@include shared/core.js*/
  /*@include shared/resolver.js*/

  if (window.__aupply && window.__aupply.platform === 'linkedin' && window.__aupply.running && window.__aupply.running()) return JSON.stringify({ ok: false, error: 'RUNNING: a queue is live; wait for it before re-pasting' });

  /* Rate limits. Fixed here on purpose: no tool input can shorten them
     (docs/automation-tools.md, "Rate limits"). */
  const P = { page: 6000, pageSlow: 8000, gapMin: 15000, gapMax: 30000, rlPause: 300000, search: 1000, jd: 1500, jdPause: 600000 };
  const R = makeResolver(CFG, 'LinkedIn');
  const ST = makeStore('__aupply_li_' + (CFG.u || 'x'), localStorage);
  const S = ST.S;
  S.running = false;
  const { status, wait } = makeStatus(CFG, ST);
  const SC = CFG.screen || {};
  const ME = CFG.me || {};
  const CONSENT = /consent|i agree|agree to|privacy notice|privacy policy|acknowledge|i understand|declare|certify|attest|terms and conditions|data processing|gdpr/i;
  const NEVERTICK = /marketing|promotion|newsletter|text message|\bsms\b|notify me|updates about|follow|subscribe/i;
  let pageWait = P.page;

  /* ---------------- DOM helpers ---------------- */
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const navBtn = () => $$('button').find((b) => /^(next|review|submit application|continue)$/i.test(txt(b)));
  // No role="dialog" and obfuscated classes: anchor the modal from its nav button.
  const modal = () => {
    const nb = navBtn();
    if (!nb) return null;
    let p = nb;
    for (let i = 0; i < 14 && p; i++) {
      p = p.parentElement;
      if (!p) break;
      if (/Apply to /.test(p.innerText || '') && p.querySelector('input,select,textarea,button')) return p;
    }
    return nb.closest('form') || nb.parentElement;
  };
  // Only trust a label from a container holding exactly one control; the old walk
  // read a neighbour's label and typed a first name into a city field.
  const lab = (el) => {
    let l = '';
    const ref = el.getAttribute('aria-labelledby');
    if (ref) { const n = document.getElementById(ref); if (n) l = n.innerText || ''; }
    if (!l && el.labels && el.labels[0]) l = el.labels[0].innerText || '';
    if (!l && el.id) { const x = document.querySelector('label[for="' + el.id + '"]'); if (x) l = x.innerText || ''; }
    if (!l) {
      let p = el.parentElement;
      for (let i = 0; i < 4 && p && !l; i++) {
        if (p.querySelectorAll('input,select,textarea').length === 1) { const q = p.querySelector('label,legend'); if (q) l = q.innerText || ''; }
        p = p.parentElement;
      }
    }
    if (!l) l = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
    return l.replace(/\s+/g, ' ').trim().slice(0, 160);
  };
  const fields = () => { const m = modal(); if (!m) return []; return $$('input,select,textarea', m).filter((e) => e.type !== 'hidden' && vis(e) && !/select language/i.test(lab(e))); };
  const optText = (e) => {
    if (e.id) { const x = document.querySelector('label[for="' + e.id + '"]'); if (x && (x.innerText || '').trim()) return x.innerText.trim(); }
    let p = e;
    for (let i = 0; i < 5 && p; i++) { p = p.parentElement; if (!p) continue; const t = (p.innerText || '').trim(); if (t && t.length < 40) return t; }
    return '';
  };
  const qOf = (els) => {
    const fs = els[0].closest('fieldset');
    let q = '';
    if (fs) { const lg = fs.querySelector('legend'); if (lg) q = lg.innerText || ''; if (!q && fs.previousElementSibling) q = fs.previousElementSibling.innerText || ''; }
    if (!q) {
      let c = els[0];
      while (c.parentElement && !els.every((e) => c.contains(e))) c = c.parentElement;
      let p = c;
      for (let i = 0; i < 4 && p && !q; i++) { let t = (p.innerText || '').replace(/\s+/g, ' ').trim(); t = t.replace(/(\s*(Yes|No))+\s*$/, ''); if (t.length >= 15) q = t; p = p.parentElement; }
    }
    return q.replace(/\s+/g, ' ').replace(/\*$/, '').trim().slice(0, 160);
  };
  const radios = () => {
    const m = modal();
    if (!m) return [];
    const g = {};
    $$('input[type=radio]', m).forEach((e) => { const n = e.name || 'x'; (g[n] = g[n] || []).push(e); });
    return Object.keys(g).map((n) => { const els = g[n]; const c = els.find((e) => e.checked); return { q: qOf(els), els, opts: els.map(optText), val: c ? optText(c) || 'selected' : null }; });
  };
  const progress = () => { const m = modal(); return ((m ? m.innerText || '' : '').match(/(\d+)\s*\/\s*(\d+)\s*pages|\d+%/) || [])[0] || ''; };
  const setVal = (el, v) => {
    const P2 = el.tagName === 'SELECT' ? HTMLSelectElement : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(P2.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const clickText = (t) => { const b = $$('button').find((x) => txt(x).toLowerCase() === t.toLowerCase()); if (!b) return false; b.click(); return true; };
  const deepAll = (sel) => {
    const out = [];
    const walk = (r) => { if (!r || !r.querySelectorAll) return; try { out.push(...r.querySelectorAll(sel)); } catch (e) { /* ignore */ } r.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); }); };
    walk(document);
    return out;
  };
  // The success confirmation and the cap dialog render in shadow roots.
  const deepText = () => {
    let out = '';
    const walk = (r) => { if (!r) return; try { out += ' ' + (r.textContent || ''); } catch (e) { /* ignore */ } if (r.querySelectorAll) r.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); }); };
    walk(document);
    return out.replace(/\s+/g, ' ');
  };
  const sentTo = () => { const m = deepText().match(/application was sent to ([^!]{1,45})/i); return m ? m[1].trim() : null; };
  const dismiss = () => { const b = deepAll('button').find((x) => /^(not now|done|dismiss|no thanks)$/i.test((x.innerText || x.textContent || '').trim())); if (b) b.click(); };
  const limitHit = () => /reached today'?s easy apply limit|easy apply limit/i.test(document.body.innerText + ' ' + deepText());
  // Easy Apply is sometimes an <a>, not a <button>.
  const easy = () => {
    const all = deepAll('button,a');
    let b = all.find((x) => /^easy apply$/i.test(txt(x)));
    if (!b) b = all.find((x) => /easy apply to this job/i.test(x.getAttribute('aria-label') || ''));
    if (!b) b = all.find((x) => /^easy apply/i.test(txt(x)));
    if (!b) return false;
    b.click();
    return true;
  };
  const closed = () => /no longer accepting applications/i.test(document.body.innerText);
  const alreadyApplied = () => /\byou applied\b|\bapplied \d+ (second|minute|hour|day|week|month)s? ago\b|application submitted/i.test(document.body.innerText);
  const pageTitle = () => { const p = (document.title || '').split('|').map((x) => x.trim()); return { t: cut(p[0], 70), co: cut(p[1], 40) }; };

  /* ---------------- filling ---------------- */
  // Month/year selects with no label anywhere: education dates or employment dates.
  const dateFill = () => {
    const m = modal();
    if (!m) return [];
    const ds = $$('select', m).filter((s) => /^(month|year)$/i.test(((s.options[0] || {}).text || '').trim()) && (!s.value || /^(month|year)$/i.test(((s.options[s.selectedIndex] || {}).text || '').trim())));
    if (!ds.length) return [];
    const edu = /education|school|degree|field of study|dates attended/i.test(m.innerText || '');
    const plan = edu ? [ME.eduFromM, ME.eduFromY, ME.eduToM, ME.eduToY] : [ME.expFromM, ME.expFromY, '', ''];
    const log = [];
    ds.forEach((s, i) => { const want = plan[i]; if (!want) return; const hit = [...s.options].find((o) => (o.text || '').trim() === String(want)); if (hit) { setVal(s, hit.value); log.push(['date' + i, String(want)]); } });
    return log;
  };

  const fill = () => {
    const log = [], un = [], prot = [];
    let typeahead = null;
    log.push(...dateFill());
    const m = modal();
    if (!m) return { log, un, prot, typeahead };
    const required = (el, L) => el.required || el.getAttribute('aria-required') === 'true' || /\*$/.test(L);
    for (const el of fields()) {
      if (el.type === 'radio' || el.type === 'checkbox') continue;
      const L = lab(el);
      if (el.tagName === 'SELECT') {
        const cur = [...el.options].find((o) => o.value === el.value);
        if (el.value && cur && !/^(select|choose)/i.test(cur.text || '')) continue;
        const opts = [...el.options].map((o) => ({ v: o.value, t: (o.text || '').trim() }));
        const a = R.A(L);
        if (a && a.protected) { prot.push(L); continue; }
        let i = R.pickOpt(a, opts.map((o) => o.t));
        if (i < 0 || !opts[i].v) i = R.lowStakes(L, opts.map((o) => o.t));
        if (i >= 0 && opts[i].v) { setVal(el, opts[i].v); log.push([L, opts[i].t]); continue; }
        un.push(L + ' [opts:' + opts.slice(0, 6).map((o) => o.t).join('/') + ']');
      } else {
        if ((el.value || '').trim()) continue;
        const a = R.A(L);
        if (a && a.protected) { if (required(el, L)) prot.push(L); continue; }
        const v = a ? (a.text != null ? a.text : a.v) : null;
        if (v == null || v === '') { if (required(el, L)) un.push(L); continue; }
        setVal(el, String(v));
        log.push([L, String(v)]);
        // City typeaheads only commit on a real click on the suggestion (applix item 45).
        if (!typeahead && (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list')) {
          const r = el.getBoundingClientRect();
          typeahead = { need: L, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
        }
      }
    }
    for (const g of radios()) {
      if (g.val) continue;
      if (/\.pdf|resume/i.test(g.q)) { g.els[0].click(); continue; }
      const a = R.A(g.q);
      if (a && a.protected) { prot.push(g.q); continue; }
      let i = R.pickOpt(a, g.opts);
      if (i < 0) i = R.lowStakes(g.q, g.opts);
      // Employer-misconfigured question (a years question wired to Yes/No): Yes, but only
      // when the resolver did answer it positively. An unknown question goes to the user.
      if (i < 0 && a && a.v != null && !/^(no|0)$/i.test(String(a.v)) && g.els.length === 2) i = g.opts.findIndex((t) => /^yes/i.test(t));
      if (i >= 0) { g.els[i].click(); log.push([g.q, g.opts[i]]); } else un.push(g.q + ' [opts:' + g.opts.join('/') + ']');
    }
    // Checkbox groups (a notice-period question once came as checkboxes), then lone
    // consent boxes. Marketing, SMS and "follow company" are never ticked.
    const boxes = $$('input[type=checkbox]', m).filter((e) => vis(e) || e.offsetParent !== null);
    const groups = new Map();
    boxes.forEach((e) => { const fs = e.closest('fieldset'); if (!fs) return; if (!groups.has(fs)) groups.set(fs, []); groups.get(fs).push(e); });
    for (const [fs, list] of groups) {
      if (list.length < 2 || list.some((e) => e.checked)) continue;
      const opts = list.map(optText);
      if (opts.every((t) => CONSENT.test(t) || NEVERTICK.test(t))) continue;
      const lg = fs.querySelector('legend');
      const q = (lg ? txt(lg) : txt(fs.previousElementSibling)).replace(/\*$/, '').slice(0, 160);
      const a = R.A(q);
      if (a && a.protected) { prot.push(q); continue; }
      const i = R.pickOpt(a, opts);
      if (i >= 0) { list[i].click(); log.push([q, opts[i]]); } else if (/\*$/.test(txt(lg) || '') || fs.querySelector('[aria-required=true],[required]')) un.push(q + ' [opts:' + opts.join('/') + ']');
    }
    boxes.forEach((e) => {
      if (e.checked) return;
      const l = (lab(e) + ' ' + optText(e)).slice(0, 300);
      if (NEVERTICK.test(l)) return;
      if (CONSENT.test(l)) { e.click(); log.push(['consent', 'ticked']); }
    });
    return { log, un, prot, typeahead };
  };

  // A numeric field that received a word: read LinkedIn's validation message and
  // convert (Yes -> years, No -> 0).
  const repair = () => {
    let n = 0;
    for (const el of fields()) {
      if (el.tagName !== 'INPUT') continue;
      let p = el, box = null;
      for (let k = 0; k < 4 && p; k++) { p = p.parentElement; if (p && /invalid input|must be a (number|whole number|decimal)|enter a (valid|whole) number|larger than|smaller than|between \d/i.test(p.innerText || '')) { box = p; break; } }
      if (!box) continue;
      const v = (el.value || '').trim();
      if (/^\d+(\.\d+)?$/.test(v)) continue;
      const nv = /^no$/i.test(v) ? '0' : v.replace(/[^\d.]/g, '') || (ME.years != null ? String(ME.years) : '');
      if (!nv) continue;
      setVal(el, nv);
      n++;
    }
    return n > 0;
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

  /* ---------------- runner ---------------- */
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
  const trackerCount = () => { const m = (document.body.innerText || '').match(/Applied\s*[·•:-]\s*([\d,]+)/i); return m ? +m[1].replace(/,/g, '') : null; };
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

  /* ---------------- drafting: sweep, then prescreen ---------------- */
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
        ST.push(Object.assign({ phase: 'swept', ids: keep.map((j) => j.id), found: map.size, dropped, tracker, a: aid() }, stop ? { stop } : {}));
      } catch (e) {
        ST.push({ phase: 'swept', ids: [], error: cut(e && e.message, 100), a: aid() });
      }
      S.running = false; S.phase = 'swept';
    })();
    return 'started';
  };

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
    const pay = R.payMax(t);
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

  const selfTest = () => {
    const fails = R.selfTest();
    if (typeof history.pushState !== 'function') fails.push('history');
    return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, h: CFG.h, platform: 'linkedin', fails });
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
  return selfTest();
})(__AUPPLY_CFG__);
