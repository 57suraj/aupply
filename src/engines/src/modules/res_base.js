/* Answer resolver 1/4: the user's facts from CFG and the parsers shared by the rules and
   the option picker (notice and numeric bands; money is in the pay module).
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
  // Whole years everywhere (the user's rule, 2 Oct): 0.5 is 1 in number fields, in dropdowns and in
  // "N+ years" questions, so one fact reaches every form. Months stay exact.
  const years = ME.years == null ? null : String(Math.round(ME.years));
  const months = ME.years == null ? null : String(Math.round(ME.years * 12));
  const lakhs = (n) => (n == null ? null : String(Math.round((n / 1e5) * 100) / 100));
  const skills = (ME.skills || []).map(norm).filter(Boolean);
  // Whole words only: "java" is not inside "javascript", nor "go" inside "mongodb".
  const skillIn = (s) => { const t = ' ' + norm(s) + ' '; return skills.some((k) => t.includes(' ' + k + ' ')); };
  const cityRe = [ME.city, ME.region].filter(Boolean).map((c) => esc(String(c).toLowerCase())).join('|');
  const namesCity = (s) => !!cityRe && new RegExp(cityRe).test(s);
  const saved = (k, dflt) => (has(KEYED[k]) ? KEYED[k] : dflt);
  // Never accepted or ticked, whatever the form calls it: marketing, SMS and "follow company".
  const NEVERTICK = /marketing|promotion|newsletter|text message|\bsms\b|notify me|updates about|follow|subscribe/i;

  const SRC = /how did you (hear|find|learn|come)|where did you (hear|find)|hear about (us|this|the|our)|referral source|source of (application|referral|hire)|how do you know (about )?us|which (channel|platform)/;
  const EEO = /gender|ethnic|\brace\b|veteran|disabilit|pronoun|self.?identif|marital|sexual orientation|hispanic|latino|military/;
  const PROTECTED = [
    [/date of birth|\bd\.?o\.?b\b|birth ?date/, 'dob'],
    [/aadha?a?r|\bpan\b.{0,12}(card|number|no\b)|passport (number|no\b)|social security|\bssn\b|national (id|insurance)|government id/, 'government_id'],
    [/\breferences?\b|\breferees?\b/, 'references'],
    [/(home|residential|permanent|street|full|postal|mailing) address|\baddress line|postal code|zip ?code|pin ?code/, 'address'],
    [/father|mother|spouse|family member/, 'family'],
  ];
  /* Technology questions, the user's own policy: Yes for their skills and for anything a
     developer with their stack picks up quickly (tools, frameworks, databases, clouds); No only
     for a technology of a language or platform they have no foothold in (POL.far, from the
     server). A question that also names one of their skills is a Yes. Strict mode ('skills'):
     Yes for their skills, anything else asked. */
  const FAR = POL.far ? new RegExp(POL.far, 'i') : null;
  const farTech = (s) => !!FAR && FAR.test(s) && !skillIn(s);
  const techYes = (s) => (POL.tech === 'skills' ? (skillIn(s) ? true : null) : !farTech(s));

  // Money parsers (moneyRange, payMax) come from the pay module.
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
  // A question that claims something about a technology (not "are you interested in this Java role").
  const CLAIM = /experien|years|months|familiar|proficien|knowledge|\bknow\b|worked|\bwork(ing)? (with|in|on)\b|\bused?\b|using|hands.?on|expertise|skill|\brate\b|rating|written|built|do you have/;
  // Industry words that always mean a domain, and ones that do only next to "domain", "industry"...
  const DOMAIN = /\b(fin ?tech|bfsi|ed ?tech|health ?tech|insur ?tech|prop ?tech|ad ?tech|mar ?tech|e-?commerce)\b/;
  const DOMAIN_NEAR = /\b(banking|financial services|finance|insurance|health ?care|pharma|retail|logistics|supply chain|telecom|gaming|real estate|automotive|manufacturing|hospitality|travel|payments)\b/;
  /* Technology and industry questions that must not reach the years rules (res_rules_a calls
     this right after its total-years threshold): a far technology, an industry domain.
     null: neither. */
  const techClaim = (s) => {
    let m;
    // A technology from a language or platform the user has no foothold in (the server's far
    // list): No, 0 years, the lowest rating; res_rules_a's years rules would hand LinkedIn's
    // "How many years of work experience do you have with Java?" the user's total (1 Oct).
    // Willingness to learn is not a claim and goes on to the other rules.
    if (farTech(s) && CLAIM.test(s) && !/willing|open to|comfortable|ready to|learn/.test(s)) {
      if (/\brate\b|rating|scale|out of/.test(s)) return val('experience.tech', '1', { yn: 'no' });
      return val('experience.tech', /how (many|much|long)|years|months|number of/.test(s) ? '0' : 'No', { yn: 'no' });
    }
    // Industry experience is work history, not a skill picked up quickly: the user's saved answer,
    // else asked once (1 Oct: FinTech got the blanket Yes). Integration work (a payment gateway,
    // an API) is a technology question and stays with the technology rules.
    m = s.match(DOMAIN) || (/\b(domain|industry|sector|vertical)\b/.test(s) ? s.match(DOMAIN_NEAR) : null);
    if (m && !/integrat|gateway|\bapis?\b|\bsdks?\b/.test(s)) {
      const k = 'domain.' + m[1].replace(/[^a-z]/g, '');
      const v = saved(k, null);
      return val(k, v, { yn: v === 'Yes' ? 'yes' : v === 'No' ? 'no' : null });
    }
    return null;
  };
  const titleWords = (t) => { const w = norm(t).split(' ').filter((x) => x.length > 2); return w.length ? new RegExp(w.map(esc).join('|'), 'i') : null; };

  return { ME, KEYED, norm, OVER, SAVED, has, NEVERTICK, years, months, lakhs, namesCity, saved, SRC, EEO, PROTECTED, farTech, techYes, techClaim, band, numRange, daysBand, val, titleWords };
}
