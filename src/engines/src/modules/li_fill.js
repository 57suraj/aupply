/* LinkedIn apply 2/3: filling the Easy Apply form, stepping through it, and one job start
   to finish (job() opens the modal, cont() fills and advances until it is sent). */
function li_fill(X) {
  'use strict';
  const { ME, R, sleep, txt, $$, vis, navBtn, modal, lab, fields, optText, radios, progress, setVal, clickText, deepAll, sentTo, dismiss, limitHit, easy, closed, alreadyApplied, CONSENT, NEVERTICK } = X;

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

  return { cont, job };
}
