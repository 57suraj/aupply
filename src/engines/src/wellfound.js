/* Aupply Wellfound engine: draft (listing pages) and apply (modal with screening form,
   cover note and location block). Ported from applix wellfound-scraper.js and
   wellfound-engine.js with the 28 Sep fixes (never sends with an unanswered question,
   company dedup before clicking, relocation block skipped).
   localStorage reads back empty on Wellfound, so the engine caches itself in
   sessionStorage (same-origin navigation keeps it). */
(function boot(CFG) {
  'use strict';
  /*@include shared/core.js*/
  /*@include shared/resolver.js*/

  const KEY = '__aupply_wellfound';
  const SS = sessionStorage;
  const R = makeResolver(CFG, 'Wellfound');
  const ST = makeStore(KEY + '_res_' + (CFG.u || 'x'), SS);
  const S = ST.S;
  S.running = false;
  const { status, wait } = makeStatus(CFG, ST);
  const SC = CFG.screen || {};
  const ME = CFG.me || {};
  const KEYED = CFG.keyed || {};
  try { SS.setItem(KEY, '(' + boot.toString() + ')(' + JSON.stringify(CFG) + ')'); } catch (e) { /* no cache */ }
  const ssGet = (k, d) => { try { const v = SS.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const ssSet = (k, v) => { try { if (v == null) SS.removeItem(KEY + k); else SS.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const shown = (e) => e.offsetParent !== null;
  const COVER = (CFG.coverNote || KEYED.cover_note || ME.summary || '').trim();

  /* ---------------- draft ---------------- */
  const re = (src) => (src ? new RegExp(src, 'i') : null);
  const scrape = async (first) => {
    for (let i = 0; i < 5; i++) { window.scrollTo(0, document.body.scrollHeight); await sleep(750); }   // more trips the 45s limit
    window.scrollTo(0, 0);
    await sleep(350);
    const acc = first ? { rows: {}, drop: {}, pages: 0 } : ssGet('_draft', { rows: {}, drop: {}, pages: 0 });
    const NEGT = re(SC.negTitle), NEGS = re(SC.negStack), NEGU = re(SC.negSlug), POS = re(SC.pos);
    const seen = new Set();
    let cards = 0;
    for (const a of $$('a[href*="/jobs/"]')) {
      const h = a.getAttribute('href') || '';
      const m = /\/jobs\/(\d+)-([a-z0-9-]*)/.exec(h);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      cards++;
      const title = (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90);
      let jc = a;
      while (jc.parentElement && jc.parentElement.querySelectorAll('a[href*="/jobs/"]').length <= 1) jc = jc.parentElement;
      const jt = (jc.innerText || '').replace(/\s+/g, ' ').trim();
      const idx = title ? jt.indexOf(title) : -1;
      const tail = idx >= 0 ? jt.slice(idx + title.length) : jt;
      const ye = (tail.match(/(\d{1,2})\+? years of exp/i) || [])[1];
      const sal = (tail.match(/₹[\d.]+[KLkl]?\s*[–-]\s*₹[\d.]+[KLkl]?/) || [])[0] || '';
      const pay = R.moneyRange(sal);
      // The URL slug is screened as well as the title ("Full Stack Software Engineer" at
      // /jobs/4677820-full-stack-net-developer).
      let r = null;
      if (NEGT && (NEGT.test(title) || NEGT.test(m[2].replace(/-/g, ' ')))) r = 'title_seniority';
      else if ((NEGS && NEGS.test(title)) || (NEGU && NEGU.test(m[2]))) r = 'title_stack';
      else if (POS && !POS.test(title)) r = 'title_off_target';
      else if (ye && SC.maxYears != null && +ye > SC.maxYears) r = 'years';
      else if (pay && SC.minPay && pay[1] < SC.minPay) r = 'pay';
      if (r) { acc.drop[r] = (acc.drop[r] || 0) + 1; continue; }
      acc.rows[m[1]] = { id: m[1], s: m[2], t: cut(title, 80), ye: ye ? +ye : null, sal: cut(sal, 30) };
    }
    acc.pages++;
    ssSet('_draft', acc);
    return JSON.stringify({ page: acc.pages, cards, kept: Object.keys(acc.rows).length });
  };
  const draft = () => { const acc = ssGet('_draft', { rows: {}, drop: {}, pages: 0 }); ssSet('_draft', null); return JSON.stringify({ jobs: Object.values(acc.rows), dropped: acc.drop, pages: acc.pages }); };

  /* ---------------- apply ---------------- */
  const optTxt = (e) => { const n = e.nextElementSibling; if (n && (n.innerText || '').trim()) return n.innerText.trim(); const p = e.parentElement; return p ? (p.innerText || '').trim() : ''; };
  const qtext = (c) => { let q = '', p = c; for (let i = 0; i < 5 && p; i++) { if (p.previousElementSibling) { const x = (p.previousElementSibling.innerText || '').replace(/\s+/g, ' ').trim(); if (x) { q = x; break; } } p = p.parentElement; } return q.replace(/\s*\*\s*$/, '').trim(); };
  const setter = (el, v) => {
    const P2 = el.tagName === 'SELECT' ? HTMLSelectElement : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(P2.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const essay = (q) => {
    let m = q.match(/(?:experience (?:using|with|in|integrating)|using|with|about)\s+([A-Za-z0-9 ,./+&'-]{3,80})/i);
    let t = m ? m[1] : '';
    t = t.replace(/\s+(for|to|when|that|which|and how)\b[\s\S]*$/i, '').replace(/[.?]+$/, '').trim();
    const body = KEYED['long.projects'] || ME.summary || '';
    if (!body) return null;
    return (t.length >= 3 ? 'I have hands on experience with ' + t + '. ' : '') + body;
  };
  const scale = (opts) => {
    const yes = opts.filter((o) => /^yes/i.test(o.t));
    if (yes.length) return yes[yes.length - 1];
    const pos = opts.filter((o) => !/^(no\b|none|never|not at all|limited|no experience|n\/a|prefer not|decline)/i.test(o.t.trim()));
    return pos.length >= 2 ? pos[1] : pos[0] || null;
  };

  // Answer the whole screening form. Clicking Send with a required question unanswered
  // returns no error; the modal just stays open.
  const wq = () => {
    const log = [], un = [], prot = [];
    const g = {};
    $$('input[type=radio]').filter(shown).forEach((e) => { (g[e.name] = g[e.name] || []).push(e); });
    for (const n of Object.keys(g)) {
      const els = g[n];
      if (els.some((e) => e.checked)) continue;
      let c = els[0];
      while (c.parentElement && !els.every((e) => c.contains(e))) c = c.parentElement;
      const q = qtext(c);
      const opts = els.map((e) => ({ e, t: optTxt(e) }));
      const texts = opts.map((o) => o.t);
      if (/location preference|update your location|where are you (based|located)/i.test(q)) {
        const o = opts.find((x) => /relocate/i.test(x.t));
        if (o && ME.relocate !== false) { o.e.click(); log.push([q, o.t]); continue; }
      }
      const a = R.A(q);
      if (a && a.protected) { prot.push(q); continue; }
      let i = R.pickOpt(a, texts);
      if (i < 0) i = R.lowStakes(q, texts);
      let pick = i >= 0 ? opts[i] : null;
      // Graded scales only when the resolver says yes (a tech question): the modest
      // positive option. Unknown questions go to the user.
      if (!pick && a && a.yn === 'yes') pick = scale(opts);
      if (pick) { pick.e.click(); log.push([q, pick.t]); } else un.push(cut(q, 80) + ' [' + texts.map((t) => cut(t, 14)).join('/') + ']');
    }
    for (const el of $$('select').filter(shown)) {
      const cur = [...el.options].find((o) => o.value === el.value);
      if (el.value && cur && !/^(select|choose|--)/i.test((cur.text || '').trim())) continue;
      const q = qtext(el);
      const texts = [...el.options].map((o) => (o.text || '').trim());
      const a = R.A(q);
      if (a && a.protected) { prot.push(q); continue; }
      let i = R.pickOpt(a, texts);
      if (i < 0) i = R.lowStakes(q, texts);
      if (i >= 0 && el.options[i].value) { setter(el, el.options[i].value); log.push([q, texts[i]]); } else un.push(cut(q, 80) + ' [select]');
    }
    for (const e of $$('textarea').filter(shown)) {
      if ((e.value || '').trim().length > 30) continue;
      const q = qtext(e);
      let v = null;
      if (!q || /cover|note|anything else|message to|tell (us|them)|introduce|what interests you|what excites|motivat|why (do you want|are you interested)/i.test(q)) v = COVER || null;
      else {
        const a = R.A(q);
        if (a && a.protected) { prot.push(q); continue; }
        if (a && a.v != null && a.k !== 'experience.tech') v = String(a.text != null ? a.text : a.v);
        else v = essay(q);
      }
      if (v) { setter(e, v); log.push(['TA:' + q, v.slice(0, 20)]); } else if (e.required) un.push(cut(q, 80) + ' [text]');
    }
    for (const e of $$('input[type=text],input[type=tel],input[type=number],input[type=url],input[type=email]').filter((x) => shown(x) && !(x.value || '').trim())) {
      const q = qtext(e);
      const a = R.A(q);
      if (a && a.protected) { if (e.required) prot.push(q); continue; }
      const v = a ? (a.text != null ? a.text : a.v) : null;
      if (v != null && v !== '') { setter(e, String(v)); log.push([q, String(v)]); } else if (e.required) un.push(cut(q, 80) + ' [text]');
    }
    return { log, un, prot };
  };

  const sendBtn = () => $$('button').find((x) => /^send application$/i.test(txt(x)));
  const cancel = () => {
    const c = $$('button').find((x) => /^cancel$/i.test(txt(x)));
    if (c) { c.click(); return; }
    [document, document.body].forEach((n) => ['keydown', 'keyup'].forEach((t) => n.dispatchEvent(new KeyboardEvent(t, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }))));
  };
  // Soft location block: pick "I can relocate", type the job's city in the input
  // underneath and click the matching suggestion.
  const loc = async () => {
    const sb = sendBtn();
    if (!sb) return 'no_send';
    let m = sb;
    for (let i = 0; i < 10 && m; i++) { const p = m.parentElement; if (!p) break; m = p; if (/update your location|location preferences/i.test(m.innerText || '')) break; }
    if (!m || !/update your location|location preferences/i.test(m.innerText || '')) return 'no_locblock';
    if (ME.relocate === false) return 'no_relocation';
    const inp = [...m.querySelectorAll('input[type=text]')].find(shown);
    if (!inp) return 'no_input';
    let city = ((document.title || '').match(/•\s*([A-Za-z ]{3,24}?)\s*(?:\||•|$)/) || [])[1] || '';
    city = city.trim();
    const cities = [city && !/remote|work from home/i.test(city) ? city : null, ME.city].filter(Boolean);
    const IS = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const c of cities) {
      inp.focus();
      IS.call(inp, c);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup', { key: c.slice(-1), bubbles: true }));
      await sleep(2000);
      const ir = inp.getBoundingClientRect();
      const cands = $$('li,[role=option],div,span').filter((e) => {
        if (!shown(e) || (e.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase() !== c.toLowerCase()) return false;
        const r = e.getBoundingClientRect();
        return r.top > ir.top && r.top - ir.bottom < 220 && Math.abs(r.left - ir.left) < 280;
      });
      if (cands.length) { cands[cands.length - 1].click(); await sleep(1500); const s2 = sendBtn(); if (s2 && !s2.disabled) return 'set:' + c; }
    }
    return 'failed';
  };
  const company = () => { const m = (document.title || '').match(/ at (.+?)(?:\s+[•|–-]\s+|\s*\||$)/); return m ? m[1].trim() : ''; };

  const hit = () => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const co = company();
    if (/✓ ?Applied/i.test(t)) return { r: 'ALREADY', co };
    // A second job at a company already applied to never opens its modal.
    if (co && (CFG.known || []).includes(co.toLowerCase())) return { r: 'DUPLICATE_COMPANY', co };
    const ym = t.match(/preferred for this role \((\d{1,2})\+? years/i);
    if (ym && SC.maxYears != null && +ym[1] > SC.maxYears) return { r: 'SKIP_YEARS', co, y: +ym[1] };
    const sm = t.match(/₹([\d.]+)L\s*[–-]\s*₹([\d.]+)L/);
    if (sm && SC.minPay && parseFloat(sm[2]) * 1e5 < SC.minPay) return { r: 'SKIP_LOWPAY', co };
    if (/relocation not allowed/i.test(t) && /on.?site/i.test(t) && ME.city && !new RegExp(esc(ME.city), 'i').test(t.slice(0, 3000))) return { r: 'SKIP_RELOCATION', co };
    if (/not accepting applications from your current location/i.test(t)) return { r: 'BLOCKED_LOC', co };
    const b = $$('button,a').find((x) => /^apply now$|^apply$/i.test(txt(x)));
    if (!b) return { r: 'NO_APPLY', co };
    b.click();
    return { r: 'CLICKED', co };
  };

  const fin = async (co) => {
    const open = () => !!sendBtn() || !!$$('textarea').find(shown);
    // The modal can take 20-30s and is not queryable while it fades in.
    for (let i = 0; i < 16 && !open(); i++) await sleep(800);
    if (!open()) { const b = $$('button,a').find((x) => /^apply now$|^apply$/i.test(txt(x))); if (b) b.click(); for (let i = 0; i < 16 && !open(); i++) await sleep(800); }
    if (!open()) return { r: 'NO_MODAL', co };
    const y2 = document.body.innerText.match(/preferred for this role \((\d{1,2})\+? years/i);
    if (y2 && SC.maxYears != null && +y2[1] > SC.maxYears) { cancel(); return { r: 'SKIP_YEARS', co, y: +y2[1] }; }
    const f = wq();
    await sleep(1100);
    const qa = f.log.slice(0, 16).map((p) => [cut(p[0], 70), cut(p[1], 40)]);
    if (f.prot.length) { cancel(); return { r: 'PROTECTED', co, need: f.prot.map((x) => cut(x, 100)), qa }; }
    if (f.un.length) { cancel(); return { r: 'NEEDS_INPUT', co, need: f.un, qa }; }
    let sb = sendBtn();
    if (!sb) { cancel(); return { r: 'NO_SEND', co, qa }; }
    let L = null;
    if (sb.disabled) {
      L = await loc();
      sb = sendBtn();
      if (!sb || sb.disabled) { cancel(); return { r: 'BLOCKED_LOC', co, loc: L, qa }; }
    }
    sb.scrollIntoView({ block: 'center' });
    await sleep(500);
    sb.click();
    await sleep(5000);
    if (!sendBtn()) return { r: 'SENT', co, qa };
    return { r: /this question is required/i.test(document.body.innerText) ? 'NEEDS_INPUT' : 'UNCONF', co, qa };
  };

  // Apply to the job on this page. Returns at once; poll wait() for the result.
  const apply = (id) => {
    if (S.running) return JSON.stringify({ r: 'RUNNING' });
    const jid = String(id || (location.pathname.match(/\/jobs\/(\d+)/) || [])[1] || '');
    S.running = true; S.phase = 'applying';
    (async () => {
      let res;
      try { const h = hit(); res = h.r === 'CLICKED' ? await fin(h.co) : h; } catch (e) { res = { r: 'ERR', e: cut(e && e.message, 100) }; }
      ST.push(Object.assign({ id: jid, a: aid() }, res, { co: cut(res.co, 40) }));
      S.running = false; S.phase = 'done';
    })();
    return JSON.stringify({ r: 'STARTED', id: jid });
  };

  const selfTest = () => { const fails = R.selfTest(); return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, h: CFG.h, platform: 'wellfound', fails }); };

  window.__aupply = {
    v: CFG.v, h: CFG.h, platform: 'wellfound',
    status, wait, running: () => !!S.running,
    all: () => JSON.stringify(ST.all()),
    scrape, draft, apply,
    selfTest, _t: { A: R.A, pickOpt: R.pickOpt },
  };
  return selfTest();
})(__AUPPLY_CFG__);
