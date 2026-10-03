# Aupply Chrome extension: bug log, solution designs and rules (testing phase)

The extension channel (LinkedIn Easy Apply, Chrome) is in live testing by the user. This file is
the working memory for whoever fixes what the tests find: how to work, the rules every fix must
keep, where to look, and every bug so far with its root cause, solution design and tests. Append a
new entry for every bug you fix; never rewrite an old one (add a "Later" note instead).

## 0. Kickoff prompt for a bug-fixing agent (copy and paste)

```
You are the bug-resolution agent for the Aupply Chrome extension, which is in its live-testing
phase. The user (Suraj) tests it in his own Chrome on his own LinkedIn account and reports what he
sees; you find the root cause, fix it, prove the fix with tests, and record it. The repository is
/Users/suraj/projects/aupply.

Before doing anything else, read these files completely, in this order:
1. docs/extension/BUGS.md: how to work, the rules you must keep, where to look, and every bug fixed
   so far with its root cause and solution design. Its rules override your defaults.
2. CLAUDE.md, in full, including its "Chrome extension channel" section (accounts, the commit
   protocol, the database rules, and the MCP rules the extension shares).
3. docs/extension/DESIGN.md: what was built, how it runs and how it is tested, and every deviation
   from the plan.
4. docs/extension/BUILD-INSTRUCTIONS.md sections 2 (hard rules), 9 (apply pipeline), 10.6 (which
   questions AI may answer), 11 (the extension) and 16 (Appendix A, the LinkedIn behaviour table).
Read docs/automation-tools.md sections "Rate limits", 6 and 7 when a bug touches pacing, results or
form answers.

Then, for each problem the user reports:
- Find the evidence first. The server records everything: query ext_events, ext_leases (detail holds
  each form page's Q&A and the result), ext_questions, answers, applications and runs for the user
  with the Supabase MCP (project lzkvozibmodysycztatl, read-only queries). Find the root cause in the
  code; do not patch the symptom.
- Fix it inside the extension channel only (src/extension, extension/, client/src/extension,
  scripts/e2e-ext.mjs, docs/extension). The MCP side is frozen: if the cause is in MCP code (the
  resolver in src/engines, src/platforms, src/services, src/mcp), stop and ask the user before
  changing it, and meanwhile fix or work around it on the extension side if that is safe.
- Add a regression test (scripts/e2e-ext.mjs for the server, extension/test for page code) that fails
  without the fix. Run npm run typecheck, npm run build, npm run test:extension, npm run e2e:ext and
  npm run e2e (servers as docs/extension/DESIGN.md "Running it" says), and the freeze check.
- If extension/ code changed, bump extension/manifest.json's version and tell the user to download
  the zip again and reload it on chrome://extensions.
- Append the bug to docs/extension/BUGS.md (symptom, evidence, root cause, solution design, files,
  tests, data repair), then commit and push to main exactly as CLAUDE.md and BUGS.md say.
- Repair user data your bug damaged only with targeted, reversible updates, and report every row.
- Report to the user in plain words: what was wrong, what changed, what they need to do (reload the
  extension or not), and anything only they can decide.
Ask the user only where BUGS.md or BUILD-INSTRUCTIONS.md section 2.7 says to ask.
```

## 1. How to work

1. **Evidence before code.** Every run leaves a trail on the server:
   - `ext_events` (`user_id`, newest first): server events (`run.*`, `draft.*`, `apply.result`,
     `tracker.mismatch`, `device.*`) and the extension's own (`client.*`: pauses, stalls, page
     loads, failed steps, refused URLs, handoffs, run ends).
   - `ext_leases`: every order and job. `detail.pages.<n>.qa` is each form page's Q&A
     (`[question, answer, source, answer_id, field_type]`), `detail.pages.<n>.questions` the
     questions raised, `detail.result` what the extension reported (`r`, `errs`, `trace`, `e`),
     `detail.outcome` what the server answered.
   - `ext_questions` (questions for the user: `key`, `status`, `waiting`, `times_seen`,
     `metadata.aliases`), `answers` (the user's facts: `key`, `status`, `source`, `metadata.origin`),
     `applications` (`metadata`: `last_result`, `fails`, `needs_input`, `retry_after`, `ext_at`),
     `runs` (client `aupply_extension`), `ext_drafts` (`state`, `stats`).
   - The side panel's Settings, "Copy debug log": the extension's own ring buffer.
2. **Root cause, then design, then code.** Write the design into the bug entry before or while
   fixing; prefer a fix that makes a whole class of bug impossible over a special case.
3. **Test it.** A regression check in `scripts/e2e-ext.mjs` (server) or `extension/test` (page
   code) that fails without the fix. All suites green, the freeze check silent.
4. **Record it here, commit, push, verify the deploy** (Vercel `/ext/v1/health`), tell the user.

## 2. Rules every fix must keep

- **Priorities** (CLAUDE.md): never hit a LinkedIn rate limit (outranks everything); automation;
  accuracy; lowest cost and most determinism. Time does not matter. Never shorten a pacing floor
  (`extension/src/shared/constants.ts`) or a server pace (30 to 45s between jobs, 2s between draft
  orders, 1s and 1.5s between guest fetches).
- **The MCP channel is frozen** (BUILD-INSTRUCTIONS.md 2.1). Import its logic read-only; never edit
  `src/mcp`, `src/services`, `src/platforms`, `src/engines`, `src/auth`, `src/api`, `src/domain`,
  `src/lib`, `src/app.ts`, `api/index.ts` or an applied migration without the user's yes. The freeze
  check (BUILD-INSTRUCTIONS.md 13.4) must print nothing before every commit.
- **Never invent a personal fact.** Protected facts (date of birth, ids, references, address,
  family) and personal circumstances (licences, visas, sponsorship, location, relocation, notice,
  pay, age, health, background checks, certifications, schedules, work arrangements, bonds) come
  only from the user's data or from the user. AI never answers them.
- **The qualifying-Yes rule** (the user, 4 Oct 2026): a yes/no question that is neither
  quantitative nor personal, about skills, experience, ability, comfort or readiness, is answered
  Yes when no rule and no saved answer of the user's covers it (`src/extension/linkedin/qualify.ts`).
  The technology policy still wins: a far technology (no foothold) or an excluded one is No. Keep
  its PERSONAL and QUANT lists conservative: when in doubt a question goes to the user.
- **Asked once, never again.** A question the user answered must never come back for that job or
  any other: their answer is saved under every wording of it (keyless), reused for rephrasings
  (aliases, then the matcher), and a question is filed under a resolver key only when the resolver
  reads answers back from that key (`isSelfKeyed` in `src/extension/engine/modules.ts`).
- **Every extension write to `applications` stamps `metadata.ext_at`** (`extAt()` in
  `src/extension/services/queue.ts`), or the extension mistakes its own writes for Claude at work.
- **Decisions stay on the server.** The extension only reads pages, fetches allowed URLs and applies
  the server's actions. No remote code, no `eval`, no URL outside `extension/src/shared/allowlist.ts`,
  no `web_accessible_resources` (B6).
- **Extension releases.** Any change under `extension/` bumps `extension/manifest.json`'s version;
  raise `EXT_MIN_VERSION` in Vercel only when an old version would do harm.
- **Data repair** only with targeted updates of rows your bug damaged, never deletes of the user's
  data without asking; list every row changed in the bug entry (ids are fine, values are not).
- **The repo is public**: no personal data (names, phone numbers, emails, salaries, the user's
  companies or answers) in code, tests, docs or commits. Tests use invented people and companies.
- **Copy**: no em dashes in anything a user reads. Plain words in the side panel.
- **Commits** (CLAUDE.md, BUILD-INSTRUCTIONS.md 2.6): explicit `git add` paths (another session
  also commits), an imperative summary line and a short body, the Co-Authored-By line,
  `gh api user --jq .login` prints `57suraj`, `git pull --rebase`, `git push`; after a backend change,
  wait for the Vercel deployment and check `https://aupply.vercel.app/ext/v1/health`.

## 3. Where things are

| Area | Files |
|---|---|
| Form answers (the order of layers) | `src/extension/services/formAnswers.ts` |
| Per-field rules (port of `li_fill`) | `src/extension/linkedin/fields.ts` |
| Qualifying-Yes rule | `src/extension/linkedin/qualify.ts` |
| Questions, aliases, answers, decisions, review | `src/extension/services/questions.ts` |
| Results, retries, backoffs, tracker | `src/extension/services/apply.ts` |
| Draft, prescreen, scoring | `src/extension/services/draft.ts`, `scoring.ts`, `src/extension/linkedin/*.ts` |
| AI client and prompts | `src/extension/ai/` |
| Built engine functions, self-keyed keys | `src/extension/engine/modules.ts` |
| The run in the browser | `extension/src/background/runner.ts` |
| Page code (port of `li_dom`, `li_fill`, `li_job`) | `extension/src/content/linkedin/` |
| Side panel | `extension/src/sidepanel/` |
| Tests | `scripts/e2e-ext.mjs`, `extension/test/` |

## 4. Bug log

### B1. Skill and experience questions asked again and again (4 Oct, first live test)

- **Symptom.** The side panel kept asking yes/no questions such as "Have you personally built
  Python scripts or backend services that process files, automate workflows, or integrate APIs,
  beyond coursework or guided tutorials?" and "Have you personally configured or troubleshot AWS S3
  uploads, cloud storage permissions, or applications running on Linux servers?".
- **Root cause.** The MCP resolver's `projects_text` rule (it matches "built", "projects",
  "applications") catches these before its technology catch-all, which would have said Yes, and
  `projects_text` has no value for a yes/no field. The AI layer then classified them as personal
  facts ("whether they have done something specific"), so they went to the user.
- **Solution design.** The user's rule: answer Yes when a question is non-quantitative and
  non-personal and No would only reject the application. `qualifies()` checks the wording is a
  yes/no question (Have/Do/Are/Can...), that it claims skill, experience, ability, comfort or
  readiness, that it is not quantitative (counts, years, money, ratings) and not personal (a
  conservative list), and that it names no far or excluded technology. It runs after the rules and
  the user's own and saved answers, before AI; source `rule:qualify` in the Q&A log.
- **Files.** `src/extension/linkedin/qualify.ts`, `src/extension/services/formAnswers.ts`.
- **Tests.** e2e "Live-test fixes": both questions answered Yes by the rule; a Java version of the
  question stays No for a user with no JVM foothold; a personal question still goes to the user.

### B2. An answered question re-opened forever, and two questions overwrote one answer (4 Oct)

- **Symptom.** A job kept coming back with the same question after the user answered it ("it tries
  again and repeats the question"). `ext_questions.times_seen` reached 4.
- **Evidence.** Both B1 questions were filed under key `projects_text` and pointed at one answer
  row; another question ("the compensation is X per month, is that acceptable?") was filed under
  `comp.expected`, and a "how many years have you built APIs" question under
  `experience.projects_shipped`.
- **Root cause.** A question was filed under whatever key the resolver gave it, and the answer was
  saved under that key. `saveAnswerFromClaude` matches an existing answer by key, so two different
  questions with one key shared, and overwrote, one row (and its question text). And the resolver
  never reads `projects_text` back (that rule reads `long.projects`), so the saved answer never
  reached the form: the question was unknown again, and re-opened.
- **Solution design.** (1) A question is filed under a key only when the resolver reads answers back
  from that same key (`selfKeyedKeys()`, derived from the built rules, plus the protected facts and
  `domain.*`), and never a long-form key on a yes/no field; otherwise it is keyless and each wording
  gets its own answer row. (2) Before anything else for an unknown field, the user's answer to that
  exact wording (or an alias) from `ext_questions` is applied directly, whatever key the resolver
  gives it. (3) Data repair: the three wrongly keyed answers and four wrongly keyed questions of the
  tester were un-keyed (answer ids 57f03dd9, fa37c2a6, 28030cc8; their texts unchanged). None of the
  wrong keys had been read by a form: the resolver does not read `comp.expected` or `projects_text`.
- **Files.** `src/extension/engine/modules.ts` (`selfKeyedKeys`, `isSelfKeyed`, self-check),
  `src/extension/services/formAnswers.ts` (`questionKey`, `answeredByUser`),
  `src/extension/services/questions.ts` (`answerQuestion`).
- **Tests.** e2e: a question the resolver files under `projects_text` is keyless; two such questions
  keep two separate keyless answers; once answered, the job's questions are not asked again.

### B3. The same question in other words asked again (4 Oct)

- **Symptom.** The user asked that a question they answered never comes back in other words
  ("do you have experience with python scripts" after answering the longer question).
- **Solution design.** Three layers, cheapest first. (1) Aliases: a new keyless question whose
  meaningful words (four letters or more) overlap an open question's by 60% or more, with the same
  kind of field and options, joins it (`metadata.aliases`); the user answers once and the answer is
  saved under every wording. (2) Trigram matching of saved and past answers (unchanged, 0.45). (3)
  The matcher (`src/extension/ai/prompts/match.ts`, fast tier): the user's confirmed answers (never
  protected facts or money) and the new question; only "the earlier answer, unchanged, is correct
  for the new question" with confidence 0.85 or more reuses it, and the answer must fit the field.
  The matcher reuses the user's own words; it never writes an answer.
- **Files.** `src/extension/services/questions.ts` (`aliasOf`, `noteQuestion`, `answerQuestion`),
  `src/extension/services/formAnswers.ts` (`fromMatch`), `src/extension/ai/prompts/match.ts`,
  `src/extension/ai/fake.ts` (`answer_match`).
- **Tests.** e2e: a rephrased open question joins it and waits for both jobs; the answer is saved
  under both wordings; a later rephrasing is answered, not asked.

### B4. A job failed on salary fields; the panel showed a stale "waits for your answers" (4 Oct)

- **Symptom.** One job ended "The form would not move on (will retry)" and failed; the run summary
  said "1 job waits for your answers" while the Questions tab was empty.
- **Evidence.** The lease's `detail.result.errs` held "Invalid input" twice; the page's Q&A showed
  the current and expected CTC fields filled with the saved prose answers ("N LPA (... INR per
  year)") as text.
- **Root cause.** LinkedIn's number questions are text inputs (marked numeric), so the extension sent
  them as `text`, and the server answered with the saved phrase. The MCP engine recovers with
  `repair()`, which asks the rules for the number; the extension's repair only rounded a decimal or
  kept a lone number, so the page stalled twice and the job failed. The waiting line was the run's
  last message, true when the run ended and stale once the user answered.
- **Solution design.** (1) `isNumeric()` reads a number field however it is drawn (type number, a
  numeric inputmode, or LinkedIn's "numeric" id), so the server applies its number rules from the
  start (a saved phrase takes the rule's number, `alt`). (2) On a stalled page the extension asks the
  server again for the fields LinkedIn refused as numbers (`refusedNumbers()`), and the server merges
  that second ask into the page's Q&A. (3) A failure reads "Failed after a retry: ..." and the done
  run shows the live counts ("Now: N questions open, M jobs waiting"). (4) A job counts as waiting
  only on questions still open: one left waiting on answered or dismissed questions is ready again.
- **Files.** `extension/src/content/linkedin/form.ts`, `job.ts`, `extension/src/background/runner.ts`,
  `extension/src/sidepanel/views/Home.tsx`, `src/extension/services/formAnswers.ts`,
  `src/extension/services/queue.ts`. Extension 0.1.2.
- **Tests.** Unit: numeric text inputs are number fields; refused numbers are found. e2e: a number
  field with a saved prose answer gets the rule's number; a second ask merges; a job waiting only on
  answered questions is not counted as waiting and is applied to.

### B5. Resolver behaviour seen in the live test (MCP side, frozen: for the user to decide)

Not fixed: they live in the shared resolver (`src/engines/src/modules/res_*.js`), which the MCP
channel uses too. The extension works around the first two.
- `projects_text` (matches "built", "projects", "applications") catches yes/no questions such as
  "Have you built ...?" before the technology rules (B1; the qualifying-Yes rule covers it).
- "How many years have you built production APIs ...?" is read as a count of projects
  (`experience.projects_shipped`), not years.
- The catch-all (it matches "with") answers "Are you okay with a 2 year service bond?" as a
  technology question: Yes. A bond is a personal commitment; it should go to the user.
- `li_dom`'s `deepText` starts at `document`, whose `textContent` is null, so the MCP engine reads the
  success message from shadow roots only (DESIGN.md, open issues).

### B6. Dozens of `chrome-extension://invalid/` requests in the LinkedIn tab's network panel (4 Oct)

- **Symptom.** Many identical failed requests to `chrome-extension://invalid/` on LinkedIn pages.
- **Root cause.** Not the extension: LinkedIn's own scripts probe for installed extensions by
  requesting known extension ids' files; Chrome rewrites a request for a file an extension does not
  expose to `chrome-extension://invalid/`. Every LinkedIn page load repeats it, and the worker tab
  loads a page per job. To confirm: the Initiator column in the network panel names LinkedIn's
  script, and the requests still appear with the Aupply extension turned off.
- **Design consequence (a rule).** The extension exposes no files to pages (no
  `web_accessible_resources`), so such probes can never find it, and it adds nothing to LinkedIn's
  DOM beyond filling the form. Keep it that way.
- **Later (4 Oct, reported again: "this still keeps happening").** Checked again; still not a bug,
  nothing changed. Evidence: (1) the built bundles (`dist/*.js`) hold no `getURL`, no
  `chrome-extension` string and no injected `img`, `link` or `script`; the only `fetch` calls go to
  allowlisted LinkedIn URLs (content) and Aupply (service worker). The other known cause of these
  requests, an orphaned content script calling `chrome.runtime.getURL` after a reload (it returns
  `chrome-extension://invalid/`), cannot happen because nothing calls it. (2) Chromium rewrites any
  page request for an extension file that is not installed or not web accessible to
  `chrome-extension://invalid/` (`kExtensionInvalidRequestURL`) and fails it inside the browser;
  nothing reaches a server. (3) LinkedIn's scan is public ("BrowserGate", 2026): about 6,000
  extension ids probed on every full page load, Chromium only. The worker tab does a full load per
  job, so a run shows the burst once per job; normal browsing shows it once per visit. The request
  the user pasted (no referer, Chrome 154) matches a page-initiated probe.
  **Decision: no fix.** Hiding the requests would mean patching `fetch` in LinkedIn's main world,
  which LinkedIn can detect and which breaks the rule above; `declarativeNetRequest` cannot touch
  `chrome-extension://` requests. They cost no rate limit (none leave the browser). If a report
  ever ties them to a real failure, check the network panel's Initiator column first: a
  `static.licdn.com` script is LinkedIn; anything from the extension's own id is ours.
