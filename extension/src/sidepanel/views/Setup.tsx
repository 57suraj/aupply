import { useState } from "react";
import type { OnboardingProposeResponse } from "../../../../src/extension/contract";
import type { UiState } from "../../shared/messages";
import { errText, send } from "../send";

/** setupGaps' names in plain words. */
const GAPS: [RegExp, string][] = [
  [/^preferences\.desired_roles/, "The roles you want (what to search for)"],
  [/^profile\.full_name/, "Your full name"],
  [/^profile\.phone/, "Your phone number"],
  [/^profile\.email/, "Your email"],
  [/^profile\.location_city/, "Your city and country"],
  [/^profile\.years_experience/, "Your years of experience"],
  [/^profile\.skills/, "Your skills"],
  [/^profile\.current_title/, "Your current job title"],
  [/^profile\.notice_period_days/, "Your notice period"],
  [/^profile\.current_salary/, "Your current salary"],
  [/^preferences\.expected_salary/, "Your expected salary"],
  [/^preferences\.max_years_required/, "The most years of experience a job may ask for"],
];
const words = (gap: string) => GAPS.find(([re]) => re.test(gap))?.[1] ?? gap;

type Form = Record<string, string>;
const PROFILE_TEXT = ["full_name", "email", "phone", "location_city", "location_country", "current_title", "current_company"];
const LABELS: Record<string, string> = {
  full_name: "Full name", email: "Email", phone: "Phone", location_city: "City", location_country: "Country", current_title: "Current job title",
  current_company: "Current company", years_experience: "Years of experience", skills: "Skills (comma separated)",
  notice_period_days: "Notice period (days)", current_salary: "Current salary (per year)", salary_currency: "Currency",
  desired_roles: "Roles you want (comma separated)", expected_salary: "Expected salary (per year)", max_years_required: "Skip jobs asking for more than (years)",
};

export function Setup({ state, onDone }: { state: UiState; onDone: () => void }) {
  const gaps = state.me?.setup_gaps ?? [];
  const [proposal, setProposal] = useState<OnboardingProposeResponse | null>(null);
  const [form, setForm] = useState<Form>({ salary_currency: "INR" });
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noResume, setNoResume] = useState(false);

  const fill = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await send<OnboardingProposeResponse>({ type: "setup/propose" });
      setProposal(p);
      const pr = p.proposal.profile as Record<string, unknown>;
      const pf = p.proposal.preferences as Record<string, unknown>;
      const next: Form = { ...form };
      for (const k of PROFILE_TEXT) if (typeof pr[k] === "string") next[k] = pr[k] as string;
      if (typeof pr.years_experience === "number") next.years_experience = String(pr.years_experience);
      if (Array.isArray(pr.skills)) next.skills = (pr.skills as string[]).join(", ");
      if (Array.isArray(pf.desired_roles)) next.desired_roles = (pf.desired_roles as string[]).join(", ");
      setForm(next);
    } catch (e) {
      if ((e as { code?: string }).code === "not_found") setNoResume(true);
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const num = (v?: string) => (v && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const profile: Record<string, unknown> = {};
      for (const k of PROFILE_TEXT) if (form[k]?.trim()) profile[k] = form[k].trim();
      if (num(form.years_experience) != null) profile.years_experience = num(form.years_experience);
      if (list(form.skills)?.length) profile.skills = list(form.skills);
      if (num(form.notice_period_days) != null) profile.notice_period_days = Math.round(num(form.notice_period_days)!);
      if (num(form.current_salary) != null) {
        profile.current_salary = Math.round(num(form.current_salary)!);
        profile.current_salary_currency = form.salary_currency || "INR";
        profile.current_salary_period = "year";
      }
      const preferences: Record<string, unknown> = {};
      if (list(form.desired_roles)?.length) preferences.desired_roles = list(form.desired_roles);
      if (num(form.expected_salary) != null) {
        preferences.expected_salary = Math.round(num(form.expected_salary)!);
        preferences.salary_currency = form.salary_currency || "INR";
        preferences.salary_period = "year";
      }
      if (num(form.max_years_required) != null) preferences.max_years_required = num(form.max_years_required);
      const body: Record<string, unknown> = { profile, preferences };
      if (history && proposal?.proposal.experiences.length) body.experiences = proposal.proposal.experiences;
      if (history && proposal?.proposal.educations.length) body.educations = proposal.proposal.educations;
      await send({ type: "setup/save", body });
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (k: string, type = "text") => (
    <div className="field" key={k}>
      <label>{LABELS[k] ?? k}</label>
      <input type={type} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </div>
  );

  return (
    <div className="col">
      <div className="card">
        <h3>A few facts first</h3>
        <p className="muted small">Forms ask for these. Aupply never makes them up, so it needs them before it applies:</p>
        <ul className="small">
          {gaps.map((g) => (
            <li key={g}>{words(g)}</li>
          ))}
        </ul>
        {!proposal && (
          <button className="primary" disabled={busy} onClick={fill}>
            {busy ? "Reading your resume..." : "Fill from my resume"}
          </button>
        )}
        {noResume && (
          <p className="small">
            Upload your resume on the{" "}
            <a href={`${state.baseUrl}/dashboard`} target="_blank" rel="noreferrer">
              Aupply dashboard
            </a>{" "}
            first, or fill the form below yourself.
          </p>
        )}
        {proposal && !proposal.ai_used && <p className="small muted">Aupply could not read the whole resume just now; fill in the rest below.</p>}
      </div>

      <div className="card col">
        <h2>Check every value</h2>
        {PROFILE_TEXT.map((k) => field(k))}
        <div className="grid2">
          {field("years_experience", "number")}
          {field("notice_period_days", "number")}
        </div>
        {field("skills")}
        {field("desired_roles")}
        <div className="grid2">
          {field("current_salary", "number")}
          {field("expected_salary", "number")}
        </div>
        <div className="grid2">
          {field("salary_currency")}
          {field("max_years_required", "number")}
        </div>
        {proposal && (proposal.proposal.experiences.length > 0 || proposal.proposal.educations.length > 0) && (
          <label className="opt small">
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Also save the work history (
            {proposal.proposal.experiences.length}) and education ({proposal.proposal.educations.length}) read from my resume
          </label>
        )}
        <button className="primary" disabled={busy} onClick={save}>
          Save
        </button>
        {error && <p className="err small">{error}</p>}
      </div>
    </div>
  );
}
