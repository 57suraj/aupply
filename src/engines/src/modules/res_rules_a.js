/* Answer resolver 2/4: the first half of the ordered rules (protected facts, source,
   EEO, numbers, pay, eligibility, education, years). rulesA(s) returns { k, v, ... } or
   null, and res_api tries res_rules_b after it.
   Order matters: each early rule exists because a later, broader rule once answered the
   question wrongly in a live application (see docs/automation-tools.md). */
function res_rules_a(X) {
  'use strict';
  const { ME, KEYED, norm, has, val, saved, esc, SOURCE, SRC, EEO, PROTECTED, years, months, lakhs, techClaim, techYes, titleWords } = X;

  // "Do you have 2+ years of software development experience?" is a yes/no on the user's
  // own total years, not a technology question (1 Oct: answered Yes for a user with 0.5).
  // A threshold that names a technology ("3+ years with React") has its own rule below.
  const GEN = '(?:hands.?on|professional|relevant|total|overall|industry|work|working|full.?time|it|software|engineering|development|developer|backend|back.?end|frontend|front.?end|full.?stack|web|programming|coding|technical)';
  const THRESHOLD = new RegExp('^(?:do|have|are|did) you\\b.*?(\\d+(?:\\.\\d+)?)\\s*\\+?\\s*(?:or more |plus )?years?\\s+(?:of |in )?(?:' + GEN + '\\s+)*experience(?:\\s+(?:in|as)\\s+(?:an? |the )?(?:' + GEN + '\\s*)+)?$');
  // The employer's name, so "Have you previously worked with WNS?" reads as a former-employee
  // question and not as "worked with <technology>" (1 Oct: answered Yes).
  const CO_STOP = /^(the|inc|ltd|llc|llp|pvt|private|limited|technologies|technology|tech|solutions|services|systems|software|group|india|global|corp|corporation|company|labs)$/;
  const coRe = (co) => { const w = norm(co).split(' ').find((x) => x.length > 2 && !CO_STOP.test(x)); return w ? new RegExp('\\b' + esc(w) + '\\b') : null; };

  // co: the employer's name when the caller knows it.
  const rulesA = (s, co) => {
    let m;
    const monthly = /per month|monthly|\/\s*month/.test(s);
    const perYear = (n) => (n == null ? null : monthly ? Math.round(n / 12) : n);
    const coName = coRe(co);

    for (const [re, key] of PROTECTED) if (re.test(s)) return has(KEYED[key]) ? val(key, KEYED[key]) : { k: 'protected', v: null, protected: true, what: key };
    if (SRC.test(s)) return val('source', SOURCE, { p: new RegExp(esc(SOURCE), 'i') });
    if (EEO.test(s)) return val('eeo', saved('eeo', null), { eeo: true });
    m = s.match(THRESHOLD);
    if (m) { const ok = ME.years == null ? null : ME.years >= parseFloat(m[1]); return val('experience.years_at_least', ok == null ? null : ok ? 'Yes' : 'No', { yn: ok == null ? null : ok ? 'yes' : 'no' }); }
    // Far technologies and industry domains (res_base), before the
    // years rules below would answer them with the user's total.
    const t = techClaim(s);
    if (t) return t;

    // Numeric questions first, before any Yes rule can fire (amendments 69, 79).
    if (/how much (total |overall |relevant )?experience/.test(s)) return val('experience.years', years);
    if (/(highest|maximum|largest|max) number of users|how many (concurrent |active )?users/.test(s)) return val('experience.users_served', saved('experience.users_served', null));
    if (/^(which|what|in which) (city|location)|^(current )?(city|location)\b/.test(s)) return val('location.city', ME.city, { p: ME.city ? new RegExp(esc(ME.city), 'i') : null });
    if (/additional months/.test(s)) return val('experience.additional_months', '0');
    if (/how many months|months of .{0,40}experience|experience in months/.test(s)) return val('experience.months', months);
    if (/how many .{0,60}(projects?|systems?|models?|applications?|apis?|services?)\b/.test(s) && /(built|shipped|deployed|taken|delivered|worked|production|personally|have you)/.test(s)) return val('experience.projects_shipped', saved('experience.projects_shipped', null));
    if (/lpa|lakh|lac\b|in lakhs/.test(s) && /expect|desired/.test(s)) return val('comp.expected', lakhs(ME.ctcExpected));
    if (/lpa|lakh|lac\b|in lakhs/.test(s) && /current|present/.test(s)) return val('comp.current', lakhs(ME.ctcCurrent));
    if (/shift|time ?zone|\b(est|edt|pst|pdt|cst|gmt|uk|us|eastern|pacific|central) (time|hours)|working hours|work hours|overlap|night|weekend|rotational|any time/.test(s)) return val('shifts', saved('shifts', 'Yes'), { yn: 'yes' });
    if (/date of joining|earliest (possible )?(date|joining)|joining date|available from|(earliest|expected|possible) start date/.test(s)) return val('start.earliest_date', ME.earliest);
    if (/notice period|when can you (join|start)|how soon (can you|you can)|in how many days|days (can you|to) join|earliest.*(join|start)|availability to join/.test(s)) return val('notice.days', ME.noticeDays == null ? null : String(ME.noticeDays), { days: ME.noticeDays });
    if (/can you (start|join|begin)\s*(immediately|right away|asap|now)|immediate joiner|immediately available/.test(s)) return val('start.immediately', ME.noticeDays == null ? null : ME.noticeDays > 0 ? 'No' : 'Yes', { yn: ME.noticeDays > 0 ? 'no' : 'yes' });
    if (/salary expectation|expected (salary|ctc|compensation|pay)|compensation expectation|desired (salary|ctc|compensation)|expect.{0,25}(ctc|salary|compensation|pay|package)/.test(s)) return val('comp.expected', perYear(ME.ctcExpected) == null ? null : String(perYear(ME.ctcExpected)), { money: ME.ctcExpected });
    if (/(current|present).{0,25}(salary|ctc|compensation|pay|package)/.test(s)) return val('comp.current', perYear(ME.ctcCurrent) == null ? null : String(perYear(ME.ctcCurrent)), { money: ME.ctcCurrent });
    if (/salary|\bctc\b|compensation|package|remuneration/.test(s)) return val('comp.expected', perYear(ME.ctcExpected) == null ? null : String(perYear(ME.ctcExpected)), { money: ME.ctcExpected });

    if (/country of residence|country do you (live|reside)|which country|where do you (currently )?reside/.test(s)) return val('location.country', ME.country, { p: ME.country ? new RegExp('^' + esc(ME.country) + '$', 'i') : null });
    // "Have you ever worked FOR <Company>" is not the capability question "worked WITH X".
    if (/have you ever worked (for|at)|current or former (employee|intern|contractor)|ever been employed (by|at)|are you a (current|former) |previously (worked|employed) (for|at)|worked (for|with) us before|employed by|offer from|associated with/.test(s) ||
      (coName && coName.test(s) && /\b(worked|employed|employee|interned|previously)\b/.test(s))) return val('former_employee', saved('former_employee', 'No'), { p: /^no\b|never employed|not employed/i });
    if (/role category|which (role|job) (category|function)|most closely matches your (current|recent)/.test(s)) return val('role.category', ME.currentTitle, { p: titleWords(ME.currentTitle) });
    if (/willing to relocate/.test(s) && /currently live|do you (currently )?(live|reside)|or are you/.test(s)) return val('relocate', ME.relocate === false ? null : 'I am willing to relocate', { p: /willing to relocate/i });
    if (/non.?compete|restrictive covenant|non.?solicit/.test(s)) return val('non_compete', saved('non_compete', 'No'), { yn: 'no' });
    if (/were you referred|referred by (a|an) (current )?employee|employee referral/.test(s)) return val('referred', saved('referred', 'No'), { yn: 'no' });
    if (/name of the (person|employee) who referred|referrer|staffing agency|agency name|if not applicable/.test(s)) return val('referrer', 'N/A');
    if (/vacation|time off planned|upcoming leave/.test(s)) return val('leave_planned', saved('leave_planned', 'No'), { yn: 'no' });
    if (/opt.?out/.test(s) && /artificial intelligence|\bai\b|algorithm/.test(s)) return val('ai_opt_out', 'No', { yn: 'no' });
    if (/\bmajor\b|field of study|speciali[sz]ation|\bstream\b/.test(s)) return val('education.major', ME.major);
    if (/^(school|university|college|institute|institution)|name of (your )?(school|university|college|institute)/.test(s)) return val('education.school', ME.school);
    if (/^degree|qualification|highest (level of )?education/.test(s)) return val('education.degree', ME.degree, { p: titleWords(ME.degree) });
    if (/years? of (professional|work|relevant|total|industry|overall|hands.?on)\s*\w*\s*experience/.test(s)) return val('experience.years', years);
    // Technology-specific before total experience, or every technology inherits the
    // headline year count from the generic rule.
    m = s.match(/experience (?:in|with|using|on)\s+([a-z0-9 .+#/-]{2,40})/);
    if (m && !/^(the |our |a |this )?(company|role|team|industry|field|total|work|software|it|development|coding|programming|years?)\b/.test(m[1].trim())) return val('experience.tech', techYes(m[1]) ? years : null, { yn: 'yes' });
    if (/how many years|years of experience|years of work|year of experience|years? (have you|do you have)|total (it |work |professional )?experience/.test(s)) return val('experience.years', years);
    return null;
  };

  return { rulesA };
}
