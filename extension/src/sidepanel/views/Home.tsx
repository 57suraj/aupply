import { useEffect, useState } from "react";
import type { PostedWithin, QueueItem, RunMode, SessionStartResponse } from "../../../../src/extension/contract";
import type { UiState } from "../../shared/messages";
import { errText, send } from "../send";

const WITHIN: [PostedWithin, string][] = [
  ["1h", "1 hour"],
  ["24h", "24 hours"],
  ["1w", "1 week"],
];
const clock = (iso: string) => new Date(iso).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });

function refusal(r: SessionStartResponse): string | null {
  switch (r.type) {
    case "started":
      return null;
    case "disabled":
    case "not_subscribed":
      return r.message;
    case "setup_needed":
      return "Your profile is missing a few facts first.";
    case "busy":
      return r.reason === "other_device"
        ? `Aupply is already running on ${r.device_name ?? "another browser"}. One run at a time keeps LinkedIn from limiting you.`
        : `Claude is using LinkedIn through Aupply. Try again after ${r.retry_at ? clock(r.retry_at) : "a while"}.`;
    case "blocked":
      return `LinkedIn asked to slow down, so it rests until ${r.until ? clock(r.until) : "later"}.`;
    case "cap_reached":
      return `Today's LinkedIn Easy Apply limit is used (${r.cap.used} of ${r.cap.cap}). Try again tomorrow, or use "Find only".`;
  }
}

export function Home({ state }: { state: UiState }) {
  const me = state.me;
  const run = state.run;
  const live = Boolean(run && run.phase !== "done");
  const [within, setWithin] = useState<PostedWithin>(me?.linkedin.posted_within_default ?? "24h");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);

  const loadQueue = async () => {
    try {
      setQueue((await send<{ items: QueueItem[] }>({ type: "queue/list" })).items);
    } catch {
      setQueue(null);
    }
  };
  useEffect(() => {
    void loadQueue();
  }, [run?.phase, run?.recent?.length, me?.linkedin.queue.ready]);

  const start = async (mode: RunMode) => {
    setBusy(true);
    setError(null);
    try {
      const r = await send<SessionStartResponse>({ type: "run/start", mode, postedWithin: within });
      setError(refusal(r));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const li = me?.linkedin;
  const cap = li?.cap;
  return (
    <>
      <div className="card">
        <h2>Today on LinkedIn</h2>
        {cap && (
          <>
            <div className="stat">
              <span>Applied</span>
              <b>
                {cap.used} of {cap.cap}
              </b>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.min(100, (cap.used / Math.max(1, cap.cap)) * 100)}%` }} />
            </div>
          </>
        )}
        <div className="stat">
          <span>Ready in your queue</span>
          <b>{li?.queue.ready ?? 0}</b>
        </div>
        <div className="stat">
          <span>Waiting on you</span>
          <b>{(li?.queue.waiting_on_you ?? 0) + (li?.queue.decisions ?? 0)}</b>
        </div>
        {li?.blocked && <div className="note">LinkedIn rests until {li.blocked.until ? clock(li.blocked.until) : "later"} (it asked Aupply to slow down).</div>}
        {li?.live_run && !li.live_run.this_device && <div className="note">Aupply is running on {li.live_run.device_name ?? "another browser"}.</div>}
        {li && !li.enabled && <div className="note bad">Aupply has paused LinkedIn in the extension for now.</div>}
      </div>

      {!live && (
        <div className="card col">
          <div className="field">
            <label>Jobs posted within</label>
            <select value={within} onChange={(e) => setWithin(e.target.value as PostedWithin)}>
              {WITHIN.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <button className="primary" disabled={busy} onClick={() => start("draft_apply")}>
            Find and apply
          </button>
          <div className="row">
            <button className="secondary" disabled={busy} onClick={() => start("apply")}>
              Apply from queue
            </button>
            <button className="secondary" disabled={busy} onClick={() => start("draft")}>
              Find only
            </button>
          </div>
          <p className="muted small">
            Aupply works in its own LinkedIn tab (the orange "Aupply" group). It can stay behind other windows. It paces itself the way
            LinkedIn allows: about a job every minute or two, at most {cap?.cap ?? 35} a day.
          </p>
          {error && <p className="err small">{error}</p>}
        </div>
      )}

      {run && <RunCard state={state} />}

      <div className="card">
        <h2>Queue</h2>
        {!queue ? (
          <p className="muted small">Loading...</p>
        ) : !queue.length ? (
          <p className="muted small">Nothing queued. "Find and apply" or "Find only" fills it.</p>
        ) : (
          <div className="list">
            {queue.slice(0, 40).map((q) => (
              <div className="item" key={q.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="t">{q.title}</span>
                  {q.score != null && <span className="pill">{q.score}</span>}
                </div>
                <div className="muted small">
                  {q.company}
                  {q.location ? ` · ${q.location}` : ""}
                </div>
                {q.reasons.length > 0 && <div className="small">{q.reasons.join("; ")}</div>}
                {q.gaps.length > 0 && <div className="small muted">Missing: {q.gaps.join("; ")}</div>}
                {!live && (
                  <button className="secondary small" style={{ marginTop: 6 }} onClick={async () => (await send({ type: "queue/remove", id: q.id }), loadQueue())}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function RunCard({ state }: { state: UiState }) {
  const run = state.run!;
  const done = run.phase === "done";
  const c = run.counters;
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{done ? "Last run" : "Running"}</h2>
        {!done && run.phase === "paused" && (
          <button className="primary" onClick={() => void send({ type: "run/resume" })}>
            Resume
          </button>
        )}
        {!done && (
          <button className="danger" disabled={run.stopRequested} onClick={() => void send({ type: "run/stop" })}>
            {run.stopRequested ? "Stopping..." : "Stop"}
          </button>
        )}
      </div>
      <div>{run.status}</div>
      {run.handoff && (
        <div className="note">
          {run.handoff.what === "follow"
            ? "One click needed: in the Aupply tab, untick the Follow box on the review page."
            : `One click needed: in the Aupply tab, choose "${run.handoff.value ?? ""}" in the list under "${run.handoff.label}".`}{" "}
          Or allow trusted clicks in Settings so Aupply can make it.
        </div>
      )}
      {run.message && <div className={`note ${done ? "" : "bad"}`}>{run.message}</div>}
      <div className="grid2 small">
        <span>Sent: {c.sent + c.unconfirmed}</span>
        <span>Waiting on you: {c.waiting}</span>
        <span>Skipped: {c.skipped}</span>
        <span>Failed: {c.failed}</span>
      </div>
      {run.draftSummary && (
        <p className="muted small">
          Search: {run.draftSummary.found} found, {run.draftSummary.read} read, {run.draftSummary.kept} kept for the queue
          {run.draftSummary.decisions ? `, ${run.draftSummary.decisions} need your decision` : ""}.
        </p>
      )}
      {run.endSummary?.trackerMismatch && (
        <div className="note">LinkedIn's Applied count moved less than Aupply sent. Unconfirmed jobs are checked again on the next run.</div>
      )}
      {run.recent.length > 0 && (
        <div className="list">
          {run.recent.slice(0, 15).map((r, i) => (
            <div className="item small" key={`${r.id}-${i}`}>
              <div className="t">{r.title || `Job ${r.id}`}</div>
              <div className="muted">
                {r.company} · {r.result}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
