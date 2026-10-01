/* LinkedIn apply 2/4: filling the Easy Apply form: fill() answers every field the modal
   shows, repair() turns what a numeric field refused (a word, a decimal) into a whole number. */
function li_fill(X) {
  'use strict';
  const { ME, R, txt, $$, vis, modal, lab, fields, optText, radios, setVal, pageTitle, CONSENT, NEVERTICK } = X;
  // LinkedIn's years fields take whole numbers only: 0.5 is "Invalid input" (1 Oct, two stalls).
  const whole = (v) => (/^\d+\.\d+$/.test(String(v)) ? String(Math.round(+v)) : v);

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
    const co = pageTitle().co; // the employer, for "have you worked with <them>" questions
    for (const el of fields()) {
      if (el.type === 'radio' || el.type === 'checkbox') continue;
      const L = lab(el);
      if (el.tagName === 'SELECT') {
        const cur = [...el.options].find((o) => o.value === el.value);
        if (el.value && cur && !/^(select|choose)/i.test(cur.text || '')) continue;
        const opts = [...el.options].map((o) => ({ v: o.value, t: (o.text || '').trim() }));
        const a = R.A(L, co);
        if (a && a.protected) { prot.push(L); continue; }
        let i = R.pickOpt(a, opts.map((o) => o.t));
        if (i < 0 || !opts[i].v) i = R.lowStakes(L, opts.map((o) => o.t));
        if (i >= 0 && opts[i].v) { setVal(el, opts[i].v); log.push([L, opts[i].t]); continue; }
        un.push(L + ' [opts:' + opts.slice(0, 6).map((o) => o.t).join('/') + ']');
      } else {
        if ((el.value || '').trim()) continue;
        const a = R.A(L, co);
        if (a && a.protected) { if (required(el, L)) prot.push(L); continue; }
        let v = a ? (a.text != null ? a.text : a.v) : null;
        if (el.tagName === 'INPUT' && a && /^experience\.(years|tech)$/.test(a.k)) v = whole(v);
        if (v == null || v === '') { if (required(el, L)) un.push(L); continue; }
        setVal(el, String(v));
        log.push([L, String(v)]);
        // A city typeahead keeps the value only once a suggestion is chosen: cont() picks one.
        if (!typeahead && (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list')) {
          const r = el.getBoundingClientRect();
          typeahead = { el, v: String(v), need: L, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
        }
      }
    }
    for (const g of radios()) {
      if (g.val) continue;
      if (/\.pdf|resume/i.test(g.q)) { g.els[0].click(); continue; }
      const a = R.A(g.q, co);
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
      const a = R.A(q, co);
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

  // A numeric field that refused its value: read LinkedIn's validation message and
  // convert (Yes -> years, No -> 0, a decimal -> the nearest whole number).
  const repair = () => {
    let n = 0;
    for (const el of fields()) {
      if (el.tagName !== 'INPUT') continue;
      let p = el, box = null;
      for (let k = 0; k < 4 && p; k++) { p = p.parentElement; if (p && /invalid input|must be a (number|whole number|decimal)|enter a (valid|whole) number|larger than|smaller than|between \d/i.test(p.innerText || '')) { box = p; break; } }
      if (!box) continue;
      const v = (el.value || '').trim();
      if (/^\d+$/.test(v)) continue;
      const nv = whole(/^no$/i.test(v) ? '0' : v.replace(/[^\d.]/g, '') || (ME.years != null ? String(ME.years) : ''));
      if (nv === v) continue;
      if (!nv) continue;
      setVal(el, nv);
      n++;
    }
    return n > 0;
  };

  return { fill, repair };
}
