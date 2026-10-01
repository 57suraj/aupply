import { useCallback, useEffect, useState } from "react";
import { applyByHand, listApplications, type Application } from "../lib/api";
import { Button } from "./Button";

/**
 * Dashboard: strong matches Aupply could not apply to (not Easy Apply), saved for the user.
 * Apply opens the job and records it as applied by the user, so it shows in the tracker as a
 * manual apply.
 */

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function SavedJobs({ onApplied }: { onApplied: () => void }) {
  const [jobs, setJobs] = useState<Application[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setJobs((await listApplications({ status: ["saved"] })).items);
    } catch (e) {
      setError(errorText(e));
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (job: Application) => {
    // Open the tab inside the click, before any await, or the browser blocks it as a popup.
    if (job.job_url) window.open(job.job_url, "_blank", "noopener,noreferrer");
    setBusyId(job.id);
    setError("");
    try {
      await applyByHand(job.id);
      setJobs((list) => (list ?? []).filter((j) => j.id !== job.id));
      onApplied();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="md:col-span-2 rounded-2xl border border-white/[0.08] bg-[#121216] overflow-hidden" id="saved-jobs">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-white/[0.02]">
        <span className="text-xs text-accent font-bold uppercase tracking-wider">Jobs</span>
        {jobs && jobs.length > 0 && <span className="text-[11px] font-mono text-zinc-500">{jobs.length} saved</span>}
      </div>

      <div className="p-6 space-y-4">
        <div>
          <h3 className="text-lg font-bold uppercase tracking-tight text-white mb-1">Saved for you</h3>
          <p className="text-zinc-400 text-sm leading-relaxed max-w-2xl">
            Strong matches Claude could not apply to because they are not Easy Apply. Apply opens the job and
            marks it as applied by you.
          </p>
        </div>

        {error && (
          <p role="alert" className="text-xs rounded-xl border px-4 py-3 border-accent/30 bg-accent/[0.08] text-accent">
            {error}
          </p>
        )}

        {jobs === null ? (
          <div className="flex items-center gap-3 text-zinc-400 text-sm py-2">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            Loading saved jobs…
          </div>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing saved yet.</p>
        ) : (
          <ul className="space-y-3" id="saved-jobs-list">
            {jobs.map((j) => (
              <li
                key={j.id}
                className="rounded-xl border border-white/[0.08] bg-[#17171d] p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <p className="text-white font-semibold truncate">{j.job_title}</p>
                  <p className="text-xs text-zinc-400 truncate">
                    {j.company_name}
                    {j.location ? ` · ${j.location}` : ""}
                  </p>
                  <p className="text-[11px] font-mono text-zinc-500">
                    {j.platform} · found {formatDate(j.created_at)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={busyId === j.id}
                  disabled={busyId !== null || !j.job_url}
                  onClick={() => apply(j)}
                >
                  Apply
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
