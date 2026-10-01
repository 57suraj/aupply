/* Answer resolver 4/4: R, what the engines and resolve_answers call.
   R.A(label, co) returns { k, v, ... } or null (co: the employer's name, when known):
     k      canonical key (stable, used by the self-test and the server)
     v      the answer, or null when the user's data lacks it (the caller then asks)
     text   free-text form of the answer when it differs from v
     yn     'yes' | 'no' intent for option lists
     p, p2  option regexes, tried first
     money  amount in currency units per year, for banded salary options
     days   notice in days, for banded notice options
     protected  a never-invent fact with no saved value: skip the job */
function res_api(X) {
  'use strict';
  const { SOURCE, esc, has, norm, OVER, SAVED, val, SRC, EEO, band, moneyRange, numRange, daysBand, payMax, lakhs, rulesA, rulesB } = X;
  const rules = (s, co) => rulesA(s, co) || rulesB(s);

  const real = (t) => { const s = String(t || '').trim(); return !!s && !/^(select|choose|--|please)/i.test(s); };
  const pickOpt = (a, texts) => {
    if (!a || !has(a.v)) return -1;
    const T = texts.map((t) => String(t || '').replace(/\s+/g, ' ').trim());
    for (const re of [a.p, a.p2]) {
      if (!re) continue;
      const i = T.findIndex((t) => real(t) && re.test(t));
      if (i >= 0) return i;
    }
    if (a.yn) {
      const want = a.yn === 'yes' ? /^yes\b/i : /^no\b/i;
      const hits = T.map((t, j) => [t, j]).filter((x) => want.test(x[0]));
      // Several "Yes, ..." options: the last is the modest one ("Yes, contributed to").
      if (hits.length) return hits[hits.length - 1][1];
    }
    if (a.money != null) { const i = band(T, moneyRange, a.money); if (i >= 0) return i; }
    if (a.days != null) { const i = daysBand(a.days, T); if (i >= 0) return i; }
    const v = String(a.v).trim();
    if (/^\d+(\.\d+)?$/.test(v)) { const i = band(T, numRange, parseFloat(v)); if (i >= 0) return i; }
    const lv = v.toLowerCase();
    let i = T.findIndex((t) => t.toLowerCase() === lv);
    if (i < 0) i = T.findIndex((t) => real(t) && t.toLowerCase().startsWith(lv));
    if (i < 0 && lv.length > 3) i = T.findIndex((t) => real(t) && t.toLowerCase().includes(lv));
    return i;
  };
  // Low-stakes questions only: EEO declines, "how did you hear" names the platform.
  // Anything else returns -1 so the question goes to the user.
  const lowStakes = (q, texts) => {
    const s = String(q || '').toLowerCase();
    const T = texts.map((t, i) => [String(t || '').trim(), i]).filter((x) => real(x[0]));
    if (!T.length) return -1;
    if (EEO.test(s)) { const d = T.find((x) => /decline|prefer not|do not wish|don'?t wish|not.{0,6}(disclose|identify|say)/i.test(x[0])); return d ? d[1] : -1; }
    if (SRC.test(s)) {
      const d = T.find((x) => new RegExp(esc(SOURCE), 'i').test(x[0])) || T.find((x) => /social|online|internet|job (board|portal|site)|website/i.test(x[0]));
      return d ? d[1] : T[0][1];
    }
    return -1;
  };

  // "What is your current location - 1. Mumbai 2. Chennai 3. Hyderabad" is a numeric
  // field: resolve the stem, answer with the matching number.
  const INLINE = /(\d+)\s*[.)]\s*([A-Za-z][A-Za-z .\/&'-]{1,28})/g;
  // The rules alone, without the user's overrides and saved answers.
  const ruled = (label, co) => {
    const opts = [...label.matchAll(INLINE)].map((x) => ({ n: x[1], t: x[2].trim() }));
    const s = label.replace(/\bexps?\b/gi, 'experience').replace(/\byrs?\b/gi, 'years').toLowerCase().replace(/[?*:]+\s*$/, '').replace(/\s+/g, ' ').trim();
    if (opts.length >= 2) {
      const stem = s.replace(INLINE, ' ').replace(/\s+/g, ' ').trim();
      const b = rules(stem, co);
      if (b && has(b.v)) { const i = pickOpt(b, opts.map((o) => o.t)); if (i >= 0) return val(b.k, opts[i].n); }
      return b ? val(b.k, null) : null;
    }
    return rules(s, co);
  };
  const A = (raw, co) => {
    const label = String(raw || '');
    const n = norm(label);
    if (!n) return null;
    if (OVER.has(n)) return val('override', OVER.get(n));
    if (SAVED.has(n)) return val('saved', SAVED.get(n));
    return ruled(label, co);
  };

  // Rule keys, not values, and the rules alone (a saved answer to one of these questions
  // must not fail it), so the test holds for every user.
  const selfTest = () => {
    const expect = [
      ['How did you hear about us?', 'source'],
      ['What is your total experience in Angular?', 'experience.tech'],
      ['How many years of work experience do you have?', 'experience.years'],
      ['Have you ever worked for Acme Corp?', 'former_employee'],
      ['How many months of experience do you have?', 'experience.months'],
      ['Which city are you currently located in?', 'location.city'],
      ['Are you currently located in Pune?', 'location.based_in'],
      ['What is your notice period?', 'notice.days'],
      ['Expected CTC (in LPA)', 'comp.expected'],
      ['Date of birth', 'protected'],
      ['What is your level of proficiency in English?', 'english'],
      ['Total IT Exp?', 'experience.years'],
      ['Do you have 2+ years of hands-on software development experience?', 'experience.years_at_least'],
      ['Do you have a valid driver\'s license?', 'drivers_license'],
    ];
    const fails = expect.filter((e) => { const a = ruled(e[0]); return !a || a.k !== e[1]; }).map((e) => e[1]);
    const ex = ruled('Have you previously worked with WNS?', 'WNS');
    if (!ex || ex.k !== 'former_employee') fails.push('former_employee_by_name');
    if (band(['Rs600,000 - Rs800,000', 'Rs800,000 - Rs1,500,000'], moneyRange, 1000000) !== 1) fails.push('money_band');
    if (daysBand(15, ['Immediate', '1-2 weeks', '3-4 weeks']) !== 1) fails.push('days_band');
    if (band(['0-1', '1-2', '3+'], numRange, 1) !== 1) fails.push('num_band');
    return fails;
  };

  return { R: { A, pickOpt, lowStakes, payMax, moneyRange, lakhs, norm, selfTest } };
}
