import { useEffect, useState } from "react";
import type { QuestionItem } from "../../../../src/extension/contract";
import { errText, send } from "../send";

/** Questions only the user can answer: answered once, saved as theirs, and every job waiting on it goes ahead. */
export function Questions() {
  const [items, setItems] = useState<QuestionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      setItems((await send<{ items: QuestionItem[] }>({ type: "questions/list" })).items);
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => void load(), []);
  if (error) return <p className="err">{error}</p>;
  if (!items) return <p className="muted">Loading...</p>;
  if (!items.length) return <div className="card muted">No questions waiting. Aupply asks here when a form wants a fact it does not have.</div>;
  return (
    <div className="list">
      {items.map((q) => (
        <QuestionCard key={q.id} q={q} onDone={load} />
      ))}
    </div>
  );
}

function QuestionCard({ q, onDone }: { q: QuestionItem; onDone: () => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card col">
      <div className="t">{q.question}</div>
      <div className="muted small">
        {q.waiting_count} job{q.waiting_count === 1 ? "" : "s"} waiting on this.
        {q.kind === "protected" && " Aupply never guesses this fact: give it only if you want Aupply to use it on forms."}
      </div>
      {q.options?.length ? (
        <div className="col">
          {q.options.map((o) => (
            <label className="opt" key={o}>
              <input type="radio" name={q.id} checked={answer === o} onChange={() => setAnswer(o)} /> {o}
            </label>
          ))}
        </div>
      ) : q.field_type === "textarea" ? (
        <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} />
      ) : (
        <input type="text" value={answer} onChange={(e) => setAnswer(e.target.value)} />
      )}
      <div className="row">
        <button className="primary" disabled={busy || !answer.trim()} onClick={() => act(() => send({ type: "questions/answer", id: q.id, answer: answer.trim() }))}>
          Save
        </button>
        <button className="secondary" disabled={busy} onClick={() => act(() => send({ type: "questions/dismiss", id: q.id }))}>
          Skip the jobs that need this
        </button>
      </div>
      {error && <p className="err small">{error}</p>}
    </div>
  );
}
