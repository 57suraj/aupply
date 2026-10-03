import { useEffect, useState } from "react";
import type { ReviewItem } from "../../../../src/extension/contract";
import { errText, send } from "../send";

/** Answers the AI wrote (submitted already, saved as provisional): confirm or edit them. */
export function Review() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      setItems((await send<{ items: ReviewItem[] }>({ type: "review/list" })).items);
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => void load(), []);
  if (error) return <p className="err">{error}</p>;
  if (!items) return <p className="muted">Loading...</p>;
  if (!items.length) return <div className="card muted">Nothing to review.</div>;
  return (
    <>
      <p className="muted small">Aupply's AI wrote these answers on forms. Confirm them, or edit them for next time.</p>
      <div className="list">
        {items.map((a) => (
          <ReviewCard key={a.id} a={a} onDone={load} />
        ))}
      </div>
    </>
  );
}

function ReviewCard({ a, onDone }: { a: ReviewItem; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.answer);
  const [error, setError] = useState<string | null>(null);
  const confirm = async (answer?: string) => {
    try {
      await send({ type: "review/confirm", id: a.id, ...(answer ? { answer } : {}) });
      onDone();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div className="card col">
      <div className="t">{a.question}</div>
      {editing ? <textarea value={text} onChange={(e) => setText(e.target.value)} /> : <div className="small">{a.answer}</div>}
      <div className="row">
        {editing ? (
          <button className="primary" disabled={!text.trim()} onClick={() => confirm(text.trim())}>
            Save
          </button>
        ) : (
          <>
            <button className="primary" onClick={() => confirm()}>
              Confirm
            </button>
            <button className="secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        )}
      </div>
      {error && <p className="err small">{error}</p>}
    </div>
  );
}
