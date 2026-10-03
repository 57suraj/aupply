import { useEffect, useState } from "react";
import type { DecisionItem } from "../../../../src/extension/contract";
import { errText, send } from "../send";

/** Jobs that want a technology the user does not list: keep (forms then answer No / 0 years for it) or drop. */
export function Decisions() {
  const [items, setItems] = useState<DecisionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      setItems((await send<{ items: DecisionItem[] }>({ type: "decisions/list" })).items);
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => void load(), []);
  const decide = async (id: string, keep: boolean) => {
    try {
      await send({ type: "decisions/submit", items: [{ id, keep }] });
      await load();
    } catch (e) {
      setError(errText(e));
    }
  };
  if (error) return <p className="err">{error}</p>;
  if (!items) return <p className="muted">Loading...</p>;
  if (!items.length) return <div className="card muted">Nothing to decide.</div>;
  return (
    <>
      <p className="muted small">
        These jobs want a technology you do not list. Keeping one means its form answers No, or 0 years, for that technology.
      </p>
      <div className="list">
        {items.map((d) => (
          <div className="card col" key={d.id}>
            <div className="t">{d.title}</div>
            <div className="muted small">
              {d.company} · wants {d.wants.join(", ")}
              {d.score != null ? ` · fit ${d.score}` : ""}
            </div>
            {d.reasons.length > 0 && <div className="small">{d.reasons.join("; ")}</div>}
            <div className="row">
              <button className="primary" onClick={() => decide(d.id, true)}>
                Keep
              </button>
              <button className="secondary" onClick={() => decide(d.id, false)}>
                Drop
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
