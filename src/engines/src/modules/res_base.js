/* Answer resolver 1/4: the user's facts from CFG and the parsers shared by the rules and
   the option picker (money, notice and numeric bands).
   One ordered rule list serves every engine and resolve_answers on the server; it
   replaced applix's four drifting resolvers. Nothing about a user is hardcoded. The
   rules are in res_rules_a and res_rules_b, A() and the option picker in res_api. */
function res_base(X) {
  'use strict';
  const { CFG, esc } = X;
  const ME = CFG.me || {};
  const KEYED = CFG.keyed || {};
  const POL = CFG.policy || {};
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const pairs = (list) => new Map((list || []).map((p) => [norm(p[0]), p[1]]));
  const OVER = pairs(CFG.overrides);
  const SAVED = pairs(CFG.saved);
  const has = (x) => x !== null && x !== undefined && x !== '';
  const fmt = (n) => (n == null ? null : String(Math.round(n * 100) / 100));
  const years = fmt(ME.years);
  const months = ME.years == null ? null : String(Math.round(ME.years * 12));
  const lakhs = (n) => (n == null ? null : String(Math.round((n / 1e5) * 100) / 100));
  const skills = (ME.skills || []).map(norm).filter(Boolean);
  const skillIn = (s) => { const t = norm(s); return skills.some((k) => k && (t.includes(k) || k.includes(t))); };
  const cityRe = [ME.city, ME.region].filter(Boolean).map((c) => esc(String(c).toLowerCase())).join('|');
  const namesCity = (s) => !!cityRe && new RegExp(cityRe).test(s);
  const saved = (k, dflt) => (has(KEYED[k]) ? KEYED[k] : dflt);

  const SRC = /how did you (hear|find|learn|come)|where did you (hear|find)|hear about (us|this|the|our)|referral source|source of (application|referral|hire)|how do you know (about )?us|which (channel|platform)/;
  const EEO = /gender|ethnic|\brace\b|veteran|disabilit|pronoun|self.?identif|marital|sexual orientation|hispanic|latino|military/;
  const PROTECTED = [
    [/date of birth|\bd\.?o\.?b\b|birth ?date/, 'dob'],
    [/aadha?a?r|\bpan\b.{0,12}(card|number|no\b)|passport (number|no\b)|social security|\bssn\b|national (id|insurance)|government id/, 'government_id'],
    [/\breferences?\b|\breferees?\b/, 'references'],
    [/(home|residential|permanent|street|full|postal|mailing) address|\baddress line|postal code|zip ?code|pin ?code/, 'address'],
    [/father|mother|spouse|family member/, 'family'],
  ];
  const techYes = (tail) => (POL.tech === 'skills' && tail && !skillIn(tail) ? null : true);

  // Money: amounts in an option or a posting, in currency units per year.
  const amounts = (t) => {
    const s = String(t || '').toLowerCase().replace(/,/g, '');
    const lakhCtx = /lpa|lakh|lac\b|\d\s*l\b/.test(s);
    const out = [];
    s.replace(/(\d+(?:\.\d+)?)\s*(k|lpa|lakhs?|lacs?|l|cr|crores?|mn|m)?\b/g, (all, n, u) => {
      let x = +n;
      u = u || '';
      if (u === 'k') x *= 1e3;
      else if (/^(lpa|lakhs?|lacs?|l)$/.test(u)) x *= 1e5;
      else if (/^(cr|crores?)$/.test(u)) x *= 1e7;
      else if (/^(mn|m)$/.test(u)) x *= 1e6;
      else if (lakhCtx && x < 1000) x *= 1e5;
      out.push(x);
      return all;
    });
    return out;
  };
  const moneyRange = (t) => {
    const s = String(t || '').toLowerCase();
    const a = amounts(s);
    if (!a.length) return null;
    const perMonth = /month|\bmo\b|pm\b/.test(s) ? 12 : 1;
    if (a.length >= 2) return [a[0] * perMonth, a[1] * perMonth];
    if (/less than|under|below|upto|up to|</.test(s)) return [0, a[0] * perMonth];
    if (/above|more than|over|\+|and above|or more|>/.test(s)) return [a[0] * perMonth, Infinity];
    return [a[0] * perMonth, a[0] * perMonth];
  };
  // Highest pay a posting states, per year, or null when it states none.
  const payMax = (t) => {
    const m = String(t || '').match(/(?:₹|rs\.?|inr)\s*[\d,.]+\s*(?:k|l|lpa|lakhs?|lacs?|cr)?\s*(?:-|–|to)\s*(?:₹|rs\.?|inr)?\s*[\d,.]+\s*(?:k|l|lpa|lakhs?|lacs?|cr)?(?:\s*(?:\/|per|a)\s*(?:yr|year|annum|month|mo))?/i);
    if (!m) return null;
    const r = moneyRange(m[0]);
    return r ? r[1] : null;
  };

  const band = (T, rangeOf, x) => {
    const ranges = T.map((t) => rangeOf(t));
    for (const pass of [0, 1]) {
      const i = ranges.findIndex((r) => r && (pass === 0 ? r[0] <= x && (x < r[1] || r[0] === r[1] || r[1] === Infinity) : r[0] <= x && x <= r[1]));
      if (i >= 0) return i;
    }
    return -1;
  };
  const numRange = (t) => {
    const s = String(t || '').toLowerCase().replace(/,/g, '').trim();
    let m = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/);
    if (m) return [+m[1], +m[2]];
    m = s.match(/(?:less than|under|below|fewer than|<|upto|up to)\s*(\d+(?:\.\d+)?)/);
    if (m) return [0, +m[1] - 1e-9];
    m = s.match(/(\d+(?:\.\d+)?)\s*\+|(?:more than|over|above|at least|>)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?\s*(?:or more|and above)/);
    if (m) return [+(m[1] || m[2] || m[3]), Infinity];
    m = s.match(/^(\d+(?:\.\d+)?)\b/);
    if (m) return [+m[1], +m[1]];
    if (/^(none|no experience|fresher)$/.test(s)) return [0, 0];
    return null;
  };
  const dayRange = (t) => {
    const s = String(t || '').toLowerCase();
    if (/serving/.test(s)) return null;
    if (/immediate|^0\s*days?$/.test(s)) return [0, 0];
    const U = (u) => (/month/.test(u) ? 30 : /week/.test(u) ? 7 : 1);
    let m = s.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*(days?|weeks?|months?)/);
    if (m) return [m[1] * U(m[3]), m[2] * U(m[3])];
    m = s.match(/(?:less than|under|within|upto|up to|<|below)\s*(\d+)?\s*(days?|weeks?|months?)/);
    if (m) return [0, (m[1] ? +m[1] : 1) * U(m[2])];
    m = s.match(/(?:more than|over|above|>)\s*(\d+)\s*(days?|weeks?|months?)/);
    if (m) return [m[1] * U(m[2]) + 1, Infinity];
    m = s.match(/(\d+)\s*(days?|weeks?|months?)/);
    if (m) return [m[1] * U(m[2]), m[1] * U(m[2])];
    m = s.match(/^(\d+)$/);
    if (m) return [+m[1], +m[1]];
    return null;
  };
  // Notice bands: the band that contains the notice, else the nearest one. "Immediate"
  // only when the notice really is zero.
  const daysBand = (days, T) => {
    const ranges = T.map((t) => dayRange(t)).map((r) => (r && r[1] === 0 && days > 0 ? null : r));
    let i = ranges.findIndex((r) => r && r[0] <= days && days <= r[1]);
    if (i >= 0) return i;
    let best = -1;
    let bestD = Infinity;
    ranges.forEach((r, j) => { if (!r) return; const d = days < r[0] ? r[0] - days : days - r[1]; if (d < bestD) { bestD = d; best = j; } });
    return best;
  };

  const val = (k, v, extra) => Object.assign({ k, v: has(v) ? v : null }, extra || {});
  const titleWords = (t) => { const w = norm(t).split(' ').filter((x) => x.length > 2); return w.length ? new RegExp(w.map(esc).join('|'), 'i') : null; };

  return { ME, KEYED, norm, OVER, SAVED, has, years, months, lakhs, namesCity, saved, SRC, EEO, PROTECTED, techYes, moneyRange, payMax, band, numRange, daysBand, val, titleWords };
}
