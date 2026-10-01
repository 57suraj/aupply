/* Answer resolver 3/4: the second half of the ordered rules (language, pitch, location,
   sponsorship, grades, facts, technology, contact fields, links, catch-all). Runs only
   when res_rules_a matched nothing. */
function res_rules_b(X) {
  'use strict';
  const { ME, KEYED, has, val, saved, years, namesCity, techYes, titleWords } = X;

  const rulesB = (s) => {
    let m;
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
      const there = m ? m[1].replace(/[^a-z ]/g, '').trim().replace(/\b\w/g, (c) => c.toUpperCase()) : "the role's city";
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
    // 1 Oct: "Do you have a valid driver's license?" got the blanket Yes.
    if (/driv(er|ing)'?s? licen[cs]e/.test(s)) { const v = saved('drivers_license', null); return val('drivers_license', v, { yn: v === 'Yes' ? 'yes' : v === 'No' ? 'no' : null }); }
    m = s.match(/(own|have) (a |an |your own )?(vehicle|car|bike|motorcycle|two.?wheeler|four.?wheeler|laptop)\b/);
    if (m) { const k = 'owns.' + m[3].replace(/\W/g, ''); const v = saved(k, null); return val(k, v, { yn: v === 'Yes' ? 'yes' : v === 'No' ? 'no' : null }); }
    if (/certificat/.test(s)) return val('certifications', saved('certifications', null), { yn: has(KEYED.certifications) ? 'yes' : null });
    if (/bachelor|degree|graduat|b\.?tech|education/.test(s)) return val('education.has_degree', ME.degree ? 'Yes' : null, { yn: 'yes' });
    if (/relocat/.test(s)) return val('relocate', ME.relocate === false ? 'No' : 'Yes', { yn: ME.relocate === false ? 'no' : 'yes' });
    if (/have you (ever )?(worked|shipped|written|modell?ed|designed|built|used|implemented|integrated|deployed|owned|led|managed|contributed)/.test(s)) return val('experience.tech', techYes(s) ? 'Yes' : null, { yn: 'yes' });
    if (/do you (use|write|code|build|work|ship|have)\b/.test(s)) return val('experience.tech', techYes(s) ? 'Yes' : null, { yn: 'yes' });
    if (/familiar|do you have (experience|knowledge)|proficient|hands.?on|knowledge of/.test(s)) return val('experience.tech', techYes(s) ? 'Yes' : null, { yn: 'yes' });
    if (/willing|comfortable|able to (work|commute|join)|can you (join|work|commute)/.test(s)) return val('willing', 'Yes', { yn: 'yes' });
    // A phone field has its own country selector: the national number, unless the question asks for the code.
    if (/phone|mobile|contact number/.test(s)) return val('phone', /country code|with code|isd|\+\d/.test(s) ? ME.phone : (ME.phoneNational || ME.phone));
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
  };

  return { rulesB };
}
