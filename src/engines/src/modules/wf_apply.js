/* Wellfound 1/2: the result store and the screening form (answers, cover note, the soft
   location block). Ported from applix wellfound-engine.js with the 28 Sep fixes (never
   sends with an unanswered question, relocation block skipped).
   localStorage reads back empty on Wellfound, so the engine caches itself in
   sessionStorage (same-origin navigation keeps it). */
function wf_apply(X) {
  'use strict';
  const { CFG, ME, KEYED, R, sleep, txt, cut, makeStore, makeStatus } = X;
  const KEY = '__aupply_wellfound';
  const SS = sessionStorage;
  const ST = makeStore(KEY + '_res_' + (CFG.u || 'x'), SS);
  const S = ST.S;
  S.running = false;
  const { status, wait } = makeStatus(CFG, ST);
  const SC = CFG.screen || {};
  const ssGet = (k, d) => { try { const v = SS.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const ssSet = (k, v) => { try { if (v == null) SS.removeItem(KEY + k); else SS.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const shown = (e) => e.offsetParent !== null;
  const COVER = (CFG.coverNote || KEYED.cover_note || ME.summary || '').trim();

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

  return { ST, S, status, wait, SC, ssGet, ssSet, $$, shown, wq, sendBtn, cancel, loc };
}
