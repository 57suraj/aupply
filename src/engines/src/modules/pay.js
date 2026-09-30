/* Money parsers shared by the answer resolver and the platform engines: the amounts an
   option or a posting states, in currency units per year. Kept apart from the resolver so
   an engine that only reads postings (the LinkedIn draft) does not load the resolver. */
function pay(X) {
  'use strict';

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

  return { moneyRange, payMax };
}
