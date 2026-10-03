/**
 * AI_FAKE=1: deterministic stand-ins for every purpose, no network. e2e depends on them.
 *   jd_facts        skills named in the posting from a fixed list, years from the text
 *   resume_profile  the profile fields' skills and years
 *   fit             skill overlap between the candidate and the job's must-haves
 *   answer          needs_user, unless the question starts with "why" or "describe"
 *   onboarding      a name from the first line, skills from the fixed list, a role from a title line
 *   answer_match    the earlier question sharing at least half of the words (four letters or more)
 */

import type { Purpose } from "./usage.js";

const SKILLS = [
  "TypeScript", "JavaScript", "Node.js", "React", "Python", "Django", "FastAPI", "Java", "Spring", "Go", "Golang", "Ruby", "PHP",
  "Angular", "Vue", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "AWS", "GCP", "Azure", "Docker", "Kubernetes", "GraphQL",
  "Next.js", "Express", "C++", "Rust", "Kotlin", "Swift", "Flutter", "SQL",
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const found = (text: string) => SKILLS.filter((s) => new RegExp(`(?<![a-z0-9])${esc(s.toLowerCase())}(?![a-z0-9])`).test(text.toLowerCase()));
const block = (text: string, tag: string) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
const json = (text: string, tag: string) => {
  try {
    return JSON.parse(block(text, tag) || "null");
  } catch {
    return null;
  }
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();

export function fakeJson(purpose: Purpose | "answer_match", user: string): unknown {
  switch (purpose) {
    case "jd_facts": {
      const posting = block(user, "posting");
      const [head = ""] = posting.trim().split("\n");
      const years = posting.match(/(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?years?/i);
      return {
        role_title: head.split(" at ")[0] || null, role_family: "software_engineering", seniority: "unknown",
        min_years: years ? Number(years[1]) : null, max_years: null, must_have: found(posting).slice(0, 12), nice_to_have: [],
        domains: [], work_mode: "unknown", locations: [], employment_type: "unknown", education: "unknown", notes: [],
        summary: head.slice(0, 200),
      };
    }
    case "resume_profile": {
      const f = json(user, "profile_fields") ?? {};
      const skills = [...new Set([...(f.skills ?? []), ...found(block(user, "resume"))])];
      return {
        headline: f.current_title ?? null, total_years: f.years_experience ?? null, recent_titles: f.current_title ? [f.current_title] : [],
        skills: skills.map((name: string) => ({ name, years: null, strength: "core" })), domains: [], education_level: "unknown", highlights: [],
      };
    }
    case "fit": {
      const c = json(user, "candidate") ?? {};
      const facts = json(user, "job_facts") ?? {};
      const have = new Set((c.skills ?? []).map((s: string) => norm(s)));
      const must: string[] = facts.must_have ?? [];
      const hits = must.filter((s) => have.has(norm(s)));
      const missing = must.filter((s) => !have.has(norm(s)));
      const score = must.length ? Math.round(30 + (60 * hits.length) / must.length) : 60;
      return {
        score, verdict: "", reasons: hits.length ? [`${hits.slice(0, 3).join(", ")} match`] : [],
        gaps: missing.length ? [`Asks for ${missing.slice(0, 3).join(", ")}`] : [],
      };
    }
    case "answer": {
      const q = json(user, "question") ?? {};
      const c = json(user, "candidate") ?? {};
      const label = String(q.label ?? "").trim();
      if (!/^(why|describe)\b/i.test(label)) {
        return { kind: "fact", answer: null, option_index: null, needs_user: true, reusable: false, confidence: 0, reason: "fake: personal fact" };
      }
      const skills = (c.skills ?? []).slice(0, 3).join(", ") || "my stack";
      return {
        kind: "long_form", answer: `The role fits the work I do every day with ${skills}, and I would like to build on it here.`,
        option_index: null, needs_user: false, reusable: true, confidence: 0.9, reason: "fake: long form",
      };
    }
    case "answer_match": {
      // Words in common (four letters or more) over all the words: 0.5 or more is "the same".
      const answered: { n: number; q: string }[] = json(user, "answered") ?? [];
      const q = json(user, "question") ?? {};
      const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length >= 4));
      const want = words(String(q.label ?? ""));
      let best: { n: number; j: number } | null = null;
      for (const a of answered) {
        const have = words(a.q);
        const both = [...want].filter((w) => have.has(w)).length;
        const j = both / Math.max(1, new Set([...want, ...have]).size);
        if (!best || j > best.j) best = { n: a.n, j };
      }
      return best && best.j >= 0.5 ? { index: best.n, confidence: 0.9 } : { index: null, confidence: 0 };
    }
    case "onboarding": {
      const text = block(user, "resume");
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      const name = lines[0] && /^[A-Z][a-z]+(\s[A-Z][a-z]+){1,3}$/.test(lines[0]) ? lines[0] : null;
      const title = lines.find((l) => /\b(engineer|developer)\b/i.test(l) && l.length < 60) ?? null;
      return {
        profile: {
          full_name: name, headline: title, summary: null, location_city: null, location_country: null, current_title: title,
          current_company: null, years_experience: null, skills: found(text), links: { linkedin: null, github: null, portfolio: null },
        },
        preferences: { desired_roles: title ? [title] : [] },
        experiences: [],
        educations: [],
      };
    }
  }
}
