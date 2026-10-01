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

// Skills that give a foothold in a family: a developer with one picks up the others quickly.
const JS = ["javascript", "js", "typescript", "ts"];
const FRONTEND = ["react", "reactjs", "react js", "next", "nextjs", "next js", "vue", "vuejs", "vue js", "nuxt", "angular", "angularjs", "svelte", ...JS];
const JVM = ["java", "core java", "spring", "spring boot", "springboot", "kotlin", "scala"];

/**
 * Main technologies: languages, frameworks and platforms, not tools. `aliases` are the
 * user's skills (normalised) that give a foothold in it: the technology itself or a close
 * neighbour (React for Vue, Java for Spring). One with no foothold is "far" for the user:
 * the draft holds jobs whose JD names one for the user's decision, and the form answers
 * No / 0 years for it. Everything outside this list (tools, libraries, databases, clouds,
 * CSS kits) counts as learnable and gets Yes. `re` matches a JD; `q` a form question, when
 * different (a question says "with Go"; a JD needs "golang" to miss the verb).
 */
export const STACK_VOCAB: { name: string; aliases: string[]; re: string; q?: string }[] = [
  { name: "Java", aliases: JVM, re: "\\bjava\\b(?!\\s*script)" },
  { name: "Spring", aliases: JVM, re: "\\bspring ?boot\\b|\\bspring (framework|mvc|cloud|security|data)\\b" },
  { name: ".NET / C#", aliases: ["net", "dotnet", "c#", "asp net", "csharp"], re: "(?<![a-z0-9])(\\.net|dotnet|dot net|asp\\.net|c#)(?![a-z0-9])" },
  { name: "PHP", aliases: ["php", "laravel", "symfony", "codeigniter", "wordpress"], re: "\\bphp\\b" },
  { name: "Laravel", aliases: ["laravel", "php"], re: "\\blaravel\\b" },
  { name: "Go", aliases: ["go", "golang"], re: "\\bgolang\\b", q: "\\bgolang\\b|\\b(in|with|using|of) go\\b(?![ -])" },
  { name: "Ruby", aliases: ["ruby", "rails", "ruby on rails"], re: "\\bruby\\b" },
  { name: "Scala", aliases: JVM, re: "\\bscala\\b" },
  { name: "Kotlin", aliases: [...JVM, "android"], re: "\\bkotlin\\b" },
  { name: "Swift", aliases: ["swift", "swiftui", "ios", "objective c"], re: "\\bswift\\b" },
  { name: "Rust", aliases: ["rust"], re: "\\brust\\b" },
  { name: "C++", aliases: ["c++", "cpp", "c"], re: "(?<![a-z0-9])c\\+\\+" },
  { name: "Elixir", aliases: ["elixir", "erlang", "phoenix"], re: "\\belixir\\b" },
  { name: "Angular", aliases: FRONTEND, re: "\\bangular(js)?\\b" },
  { name: "Vue", aliases: FRONTEND, re: "\\bvue(\\.?js)?\\b" },
  { name: "React Native", aliases: ["react native", "expo", ...FRONTEND], re: "\\breact[ -]native\\b" },
  { name: "Flutter", aliases: ["flutter", "dart"], re: "\\bflutter\\b" },
  { name: "Android", aliases: ["android", "kotlin"], re: "\\bandroid\\b" },
  { name: "iOS", aliases: ["ios", "swift", "swiftui", "objective c"], re: "\\bios\\b" },
  { name: "Salesforce", aliases: ["salesforce", "apex"], re: "\\bsalesforce\\b" },
  { name: "SAP", aliases: ["sap", "abap"], re: "\\bsap\\b" },
  { name: "Python", aliases: ["python", "django", "flask", "fastapi"], re: "\\bpython\\b" },
  { name: "Node.js", aliases: ["node", "nodejs", "node js", "express", "express js", "expressjs", "nestjs", "nest js", "fastify", ...JS], re: "\\bnode(\\.?js)?\\b" },
  { name: "React", aliases: FRONTEND, re: "\\breact(\\.?js)?\\b(?![ -]native)" },
  { name: "TypeScript", aliases: [...JS, "node", "nodejs", "node js", ...FRONTEND], re: "\\btypescript\\b" },
  { name: "JavaScript", aliases: [...JS, "node", "nodejs", "node js", ...FRONTEND], re: "\\bjavascript\\b" },
];
