import { useEffect, useState } from "react";
import { listApplications, type Application } from "../lib/api";

/**
 * Dashboard: every application sent, most recent first. A job the user applied to by hand
 * (from Saved for you) carries a Manual apply badge.
 */

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

const STATUS_LABEL: Record<string, string> = { applied: "Applied", unconfirmed: "Sent, not confirmed" };

export function ApplicationTracker({ version }: { version: number }) {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  // version changes when the user applies to a saved job, so the new row shows at once.
  useEffect(() => {
    let live = true;
    listApplications({ status: ["applied", "unconfirmed"], sort: "applied", limit: 50 })
      .then((r) => {
        if (!live) return;
        setApps(r.items);
        setTotal(r.total);
      })
      .catch((e) => {
        if (!live) return;
        setError(errorText(e));
        setApps([]);
      });
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <div className="md:col-span-2 rounded-2xl border border-white/[0.08] bg-[#121216] overflow-hidden" id="application-tracker">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-white/[0.02]">
        <span className="text-xs text-accent font-bold uppercase tracking-wider">History</span>
        {total > 0 && <span className="text-[11px] font-mono text-zinc-500">{total} sent</span>}
      </div>

      <div className="p-6 space-y-4">
        <h3 className="text-lg font-bold uppercase tracking-tight text-white">Applications</h3>

        {error && (
          <p role="alert" className="text-xs rounded-xl border px-4 py-3 border-accent/30 bg-accent/[0.08] text-accent">
            {error}
          </p>
        )}

        {apps === null ? (
          <div className="flex items-center gap-3 text-zinc-400 text-sm py-2">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            Loading applications…
          </div>
        ) : apps.length === 0 ? (
          <p className="text-sm text-zinc-500">No applications yet.</p>
        ) : (
          <ul className="divide-y divide-white/[0.06]" id="application-list">
            {apps.map((a) => (
              <li key={a.id} className="py-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-white font-medium truncate">
                    {a.job_url ? (
                      <a href={a.job_url} target="_blank" rel="noopener noreferrer" className="hover:text-accent transition-colors">
                        {a.job_title}
                      </a>
                    ) : (
                      a.job_title
                    )}
                  </p>
                  <p className="text-xs text-zinc-400 truncate">
                    {a.company_name} · {a.platform}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap sm:justify-end shrink-0">
                  {a.applied_by === "user" && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent/[0.12] text-accent border border-accent/30">
                      Manual apply
                    </span>
                  )}
                  <span className="text-xs text-zinc-300">{STATUS_LABEL[a.status] ?? a.status}</span>
                  <span className="text-[11px] font-mono text-zinc-500">{formatDate(a.applied_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
