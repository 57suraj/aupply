/* Shared answer resolver: one ordered rule list used by every engine.
   Replaces applix's four drifting resolvers and their __A0 -> __Av1 -> ... wrapper
   chains. Every personal value comes from CFG; nothing about a user is hardcoded.

   A(label) returns { k, v, ... } or null:
     k      canonical key (stable, used by the self-test and the server)
     v      the answer, or null when the user's data lacks it (the caller then asks)
     text   free-text form of the answer when it differs from v
     yn     'yes' | 'no' intent for option lists
     p, p2  option regexes, tried first
     money  amount in currency units per year, for banded salary options
     days   notice in days, for banded notice options
     protected  a never-invent fact with no saved value: skip the job
   Order matters: each early rule exists because a later, broader rule once answered
   the question wrongly in a live application (see docs/automation-tools.md). */
function makeResolver(CFG, SOURCE) {
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

  const val = (k, v, extra) => Object.assign({ k, v: has(v) ? v : null }, extra || {});
  const titleWords = (t) => { const w = norm(t).split(' ').filter((x) => x.length > 2); return w.length ? new RegExp(w.map(esc).join('|'), 'i') : null; };

  function rules(s) {
    let m;
    const saved = (k, dflt) => (has(KEYED[k]) ? KEYED[k] : dflt);
    const monthly = /per month|monthly|\/\s*month/.test(s);
    const perYear = (n) => (n == null ? null : monthly ? Math.round(n / 12) : n);

    for (const [re, key] of PROTECTED) if (re.test(s)) return has(KEYED[key]) ? val(key, KEYED[key]) : { k: 'protected', v: null, protected: true, what: key };
    if (SRC.test(s)) return val('source', SOURCE, { p: new RegExp(esc(SOURCE), 'i') });
    if (EEO.test(s)) return val('eeo', saved('eeo', null), { eeo: true });

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
    if (/have you ever worked (for|at)|current or former (employee|intern|contractor)|ever been employed (by|at)|are you a (current|former) |previously (worked|employed) (for|at)|worked (for|with) us before|employed by|offer from|associated with/.test(s)) return val('former_employee', saved('former_employee', 'No'), { p: /^no\b|never employed|not employed/i });
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

    if (/english/.test(s) && /rate|scale|out of 10|1 to 10/.test(s)) return val('english', '9');
    if (/proficiency in english|english proficiency|level of english|english (communication|fluency)/.test(s)) return val('english', saved('english', 'Fluent'), { p: /fluent|full professional|professional|advanced/i });
    if (/^summary$|professional summary|profile summary|about (you|yourself)|brief (bio|summary)|tell us about (you|yourself)|introduce yourself|anything else about yourself|tell us anything else/.test(s)) return val('pitch.summary', ME.summary);
    if (/cover (letter|note)|why (do you want|are you interested|this role|us|should we)|what interests you|what excites you|motivat/.test(s)) return val('cover_note', saved('cover_note', ME.summary));
    if (/why are you (currently )?(seeking|looking)|reason for (change|leaving|job change|switch)/.test(s)) return val('why_seeking', saved('why_seeking', null));
    if (/tool calling|function calling|ai.?agent|agentic|langchain|langgraph|prompt engineering|\brag\b|vector (database|search)|embedding|pgvector|semantic search|context.?engineering|\bllm\b|gen.?ai/.test(s)) return val('experience.tech', 'Yes', { yn: 'yes', text: saved('long.ai_work', 'Yes') });
    if (/follow(ed|ing)?\s+(the\s+)?.{0,40}page|follow(ed|ing)?\s+us\s+on|are you following/.test(s)) return val('follows_page', 'Yes', { yn: 'yes' });
    // "Are you based out of Bangalore?": truthful. Text fields get a sentence, option
    // lists get Yes only when the question names the user's city.
    if (/are you (currently )?(based|located|living|residing) (in|at|out of)|currently (based|located|living) in|do you (live|reside|stay) in|based out of/.test(s)) {
      const here = namesCity(s);
      m = s.match(/(?:out of|in|at)\s+([a-z .]{3,22})/);
      const there = m ? m[1].replace(/[^a-z ]/g, '').trim().replace(/\b\w/g, (c) => c.toUpperCase()) : 'the role’s city';
      const sentence = here ? 'Yes' : ME.city ? 'I am currently based in ' + ME.city + (ME.relocate === false ? '.' : ' and I am willing to relocate to ' + there + ' for a work from office role.') : null;
      return val('location.based_in', sentence, { yn: here ? 'yes' : 'no' });
    }
    if (/position is based|based out of our office|office location/.test(s)) return val('location.office', ME.city, { yn: ME.relocate === false ? null : 'yes' });
    if (/sponsor/.test(s) && /united states|\bu\.?s\.?a?\b|america/.test(s)) { const d = ME.country && !/united states|^us$|^usa$/i.test(ME.country) ? 'Yes' : null; const v = saved('sponsorship.us', d); return val('sponsorship.us', v, { yn: v === 'Yes' ? 'yes' : v === 'No' ? 'no' : null }); }
    if (/sponsor|visa|h-?1b|work permit/.test(s)) { const v = saved('sponsorship.home', 'No'); return val('sponsorship.home', v, { yn: v === 'Yes' ? 'yes' : 'no' }); }
    if (/authori[sz]|legally|eligible to work|right to work/.test(s)) { const v = saved('work_auth.home', 'Yes'); return val('work_auth.home', v, { yn: v === 'No' ? 'no' : 'yes' }); }
    if (/(b\.?tech|b\.?e\b|bachelor|graduation|\bug\b).{0,20}(gpa|cgpa|percentage|marks|score)|cgpa/.test(s)) return val('education.grade', ME.gradeUg);
    if (/(inter|12th|intermediate|hsc|senior secondary)/.test(s) && /(gpa|cgpa|percentage|marks|score)/.test(s)) return val('education.grade_12', ME.grade12);
    if (/(10th|ssc|matric)/.test(s) && /(gpa|cgpa|percentage|marks|score)/.test(s)) return val('education.grade_10', ME.grade10);
    // Facts before the generic "do you have ..." tech rules, which would otherwise
    // answer "Do you have a valid passport?" with a blanket Yes.
    if (/passport/.test(s)) { const v = saved('passport', null); return val('passport', v, { yn: v === 'Yes' ? 'yes' : v === 'No' ? 'no' : null }); }
    if (/certificat/.test(s)) return val('certifications', saved('certifications', null), { yn: has(KEYED.certifications) ? 'yes' : null });
    if (/bachelor|degree|graduat|b\.?tech|education/.test(s)) return val('education.has_degree', ME.degree ? 'Yes' : null, { yn: 'yes' });
    if (/relocat/.test(s)) return val('relocate', ME.relocate === false ? 'No' : 'Yes', { yn: ME.relocate === false ? 'no' : 'yes' });
    if (/have you (ever )?(worked|shipped|written|modell?ed|designed|built|used|implemented|integrated|deployed|owned|led|managed|contributed)/.test(s)) return val('experience.tech', techYes(s) ? 'Yes' : null, { yn: 'yes' });
    if (/do you (use|write|code|build|work|ship|have)\b/.test(s)) return val('experience.tech', techYes(s) ? 'Yes' : null, { yn: 'yes' });
    if (/familiar|do you have (experience|knowledge)|proficient|hands.?on|knowledge of/.test(s)) return val('experience.tech', techYes(s) ? 'Yes' : null, { yn: 'yes' });
    if (/willing|comfortable|able to (work|commute|join)|can you (join|work|commute)/.test(s)) return val('willing', 'Yes', { yn: 'yes' });
    if (/phone|mobile|contact number/.test(s)) return val('phone', ME.phone);
    if (/e-?mail/.test(s)) return val('email', ME.email);
    if (/type your full name|signature|full name|your name/.test(s)) return val('name.full', ME.fullName);
    if (/preferred name/.test(s)) return val('name.preferred', ME.preferredName || ME.firstName);
    if (/first name/.test(s)) return val('name.first', ME.firstName);
    if (/last name|surname/.test(s)) return val('name.last', ME.lastName);
    if (/current (company|employer)|most recent employer/.test(s)) return val('employment.current_company', ME.currentCompany);
    if (/current job title|current (title|designation|role|position)|^job title$|^headline$|present designation/.test(s)) return val('employment.current_title', ME.currentTitle, { p: titleWords(ME.currentTitle) });
    if (/linkedin/.test(s)) return val('links.linkedin', ME.linkedin);
    if (/github|portfolio|website|personal (site|url)/.test(s)) return val('links.portfolio', ME.github || ME.website);
    if (/city|current location|where.{0,15}(base|locat|live)|location/.test(s)) return val('location.city', ME.city);
    if (/rate your|rating|scale of|out of 10|1 to 10|proficiency/.test(s)) return val('scale', /10/.test(s) ? '8' : '4');
    if (/\bskills\b|technolog|tech stack/.test(s)) return val('skills_text', (ME.skills || []).join(', '));
    if (/applications?|solutions?|projects?|contribution|worked on|\bbuilt\b/.test(s)) return val('projects_text', saved('long.projects', null));
    // Catch-all, last so it never pre-empts a specific rule: bare noun-phrase prompts
    // such as "AI development experience?".
    if (/experience|expertise|exposure|skill|knowledge|worked on|familiarity|\bwith\b|using/.test(s)) return val('experience.tech', techYes(s) ? years : null, { yn: 'yes' });
    return null;
  }

  // "What is your current location - 1. Mumbai 2. Chennai 3. Hyderabad" is a numeric
  // field: resolve the stem, answer with the matching number.
  const INLINE = /(\d+)\s*[.)]\s*([A-Za-z][A-Za-z .\/&'-]{1,28})/g;
  const A = (raw) => {
    const label = String(raw || '');
    const n = norm(label);
    if (!n) return null;
    if (OVER.has(n)) return val('override', OVER.get(n));
    if (SAVED.has(n)) return val('saved', SAVED.get(n));
    const opts = [...label.matchAll(INLINE)].map((x) => ({ n: x[1], t: x[2].trim() }));
    const s = label.replace(/\bexps?\b/gi, 'experience').replace(/\byrs?\b/gi, 'years').toLowerCase().replace(/[?*:]+\s*$/, '').replace(/\s+/g, ' ').trim();
    if (opts.length >= 2) {
      const stem = s.replace(INLINE, ' ').replace(/\s+/g, ' ').trim();
      const b = rules(stem);
      if (b && has(b.v)) { const i = pickOpt(b, opts.map((o) => o.t)); if (i >= 0) return val(b.k, opts[i].n); }
      return b ? val(b.k, null) : null;
    }
    return rules(s);
  };

  // Rule keys, not values, so the test holds for every user. A failure means the
  // pasted engine was corrupted in transit: paste it again.
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
    ];
    const fails = expect.filter((e) => { const a = A(e[0]); return !a || a.k !== e[1]; }).map((e) => e[1]);
    if (band(['Rs600,000 - Rs800,000', 'Rs800,000 - Rs1,500,000'], moneyRange, 1000000) !== 1) fails.push('money_band');
    if (daysBand(15, ['Immediate', '1-2 weeks', '3-4 weeks']) !== 1) fails.push('days_band');
    if (band(['0-1', '1-2', '3+'], numRange, 1) !== 1) fails.push('num_band');
    return fails;
  };

  return { A, pickOpt, lowStakes, payMax, moneyRange, lakhs, norm, selfTest };
}
