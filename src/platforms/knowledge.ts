/**
 * Platform knowledge measured in applix: facts about the sites, true for every user.
 * User choices (companies they avoid, stacks they skip) live in preferences instead.
 */

/** Posters that flood results with junk (annotation gigs, freelancer spam, agencies). */
export const SPAM_COMPANIES = ["dataannotation", "data annotation", "soul ai", "cube labs", "conduent"];

/** Naukri companies whose listings always route to "Apply on company site". */
export const NAUKRI_ALWAYS_EXTERNAL = [
  "UST", "Rupstech", "Bitcot", "Csrhat", "Devnagri", "Presear", "Iflowtech", "Kalavid", "Codieslab",
  "Dscholar", "E4 Software Services", "Simptra", "FYNXT", "Trinet Group", "Proxelera", "Wiom", "Zionstar Edtech",
];

/** LinkedIn job-ad networks: applications land but never get a reply. Ranked last. */
export const LINKEDIN_AGGREGATORS = ["joveo", "jobgether", "secondwind"];

/** Seniority words dropped from titles unless the user targets senior roles. */
export const SENIOR_TITLE_TERMS = ["senior", "sr", "lead", "principal", "staff", "architect", "manager", "head", "director", "vp", "chief", "iii", "iv"];
/** Dropped unless the user wants internships. */
export const JUNIOR_TITLE_TERMS = ["intern", "interns", "internship", "trainee", "apprentice", "fresher", "freshers", "fresh graduate", "fresh graduates"];

export const LINKEDIN_GEO_IDS: Record<string, string> = { india: "102713980" };

/** Wellfound's role slugs (wellfound.com/role/l/<slug>/<location>). */
export const WELLFOUND_ROLE_SLUGS = [
  "backend-engineer", "full-stack-engineer", "software-engineer", "ai-engineer", "python-developer", "nodejs-developer",
  "machine-learning-engineer", "backend-developer", "full-stack-developer", "javascript-developer",
  "artificial-intelligence-engineer", "ai-ml-engineer", "frontend-engineer", "react-developer", "data-engineer",
  "devops-engineer", "mobile-engineer", "android-developer", "ios-developer", "java-developer",
];

/**
 * Main technologies for the draft-time stack check: languages and frameworks, not
 * tools. `aliases` are matched against the user's normalised skills to decide whether
 * the user has it; `re` is matched against the JD body.
 */
export const STACK_VOCAB: { name: string; aliases: string[]; re: string }[] = [
  { name: "Java", aliases: ["java", "core java", "spring", "spring boot"], re: "\\bjava\\b(?!\\s*script)" },
  { name: "Spring", aliases: ["spring", "spring boot", "springboot"], re: "\\bspring ?boot\\b|\\bspring framework\\b" },
  { name: ".NET / C#", aliases: ["net", "dotnet", "c#", "asp net", "csharp"], re: "(?<![a-z0-9])(\\.net|dotnet|dot net|asp\\.net|c#)(?![a-z0-9])" },
  { name: "PHP", aliases: ["php", "laravel"], re: "\\bphp\\b" },
  { name: "Laravel", aliases: ["laravel"], re: "\\blaravel\\b" },
  { name: "Go", aliases: ["go", "golang"], re: "\\bgolang\\b" },
  { name: "Ruby", aliases: ["ruby", "rails", "ruby on rails"], re: "\\bruby\\b" },
  { name: "Scala", aliases: ["scala"], re: "\\bscala\\b" },
  { name: "Kotlin", aliases: ["kotlin"], re: "\\bkotlin\\b" },
  { name: "Swift", aliases: ["swift", "ios"], re: "\\bswift\\b" },
  { name: "Rust", aliases: ["rust"], re: "\\brust\\b" },
  { name: "C++", aliases: ["c++", "cpp"], re: "(?<![a-z0-9])c\\+\\+" },
  { name: "Elixir", aliases: ["elixir"], re: "\\belixir\\b" },
  { name: "Angular", aliases: ["angular", "angularjs"], re: "\\bangular(js)?\\b" },
  { name: "Vue", aliases: ["vue", "vuejs", "vue js", "nuxt"], re: "\\bvue(\\.?js)?\\b" },
  { name: "React Native", aliases: ["react native"], re: "\\breact[ -]native\\b" },
  { name: "Flutter", aliases: ["flutter", "dart"], re: "\\bflutter\\b" },
  { name: "Android", aliases: ["android", "kotlin"], re: "\\bandroid\\b" },
  { name: "iOS", aliases: ["ios", "swift"], re: "\\bios\\b" },
  { name: "Salesforce", aliases: ["salesforce", "apex"], re: "\\bsalesforce\\b" },
  { name: "SAP", aliases: ["sap", "abap"], re: "\\bsap\\b" },
  { name: "Python", aliases: ["python", "django", "flask", "fastapi"], re: "\\bpython\\b" },
  { name: "Node.js", aliases: ["node", "nodejs", "node js", "express", "nestjs", "nest js"], re: "\\bnode(\\.?js)?\\b" },
  { name: "React", aliases: ["react", "reactjs", "react js", "next", "nextjs", "next js"], re: "\\breact(\\.?js)?\\b(?![ -]native)" },
  { name: "TypeScript", aliases: ["typescript", "ts"], re: "\\btypescript\\b" },
  { name: "JavaScript", aliases: ["javascript", "js", "typescript", "node", "nodejs", "react"], re: "\\bjavascript\\b" },
];
