import { useEffect, useState } from "react";
import type { UiState } from "../../shared/messages";
import { errText, send } from "../send";

/** Connect: start a pairing, show the code, poll every 3 seconds until the website approves. */
export function Connect({ state }: { state: UiState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const pairing = state.pairing;

  useEffect(() => {
    if (!pairing) return;
    let stop = false;
    const t = setInterval(async () => {
      if (stop) return;
      try {
        const status = await send<string>({ type: "auth/poll" });
        if (status === "denied") setNote("The request was denied on the website. Start again if that was a mistake.");
        if (status === "expired") setNote("The code expired. Start again.");
      } catch (e) {
        setError(errText(e));
      }
    }, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [pairing?.user_code]);

  const start = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await send({ type: "auth/start" });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (pairing) {
    return (
      <div className="card col">
        <h3>Approve this browser</h3>
        <p className="muted">Approve it on the Aupply page that just opened. Check that the code there matches this one.</p>
        <div className="big">{pairing.user_code}</div>
        <p className="muted small">Waiting for approval...</p>
        <div className="row">
          <a href={pairing.verify_url} target="_blank" rel="noreferrer">
            Open the approval page again
          </a>
          <button className="secondary" onClick={() => void send({ type: "auth/cancel" })}>
            Cancel
          </button>
        </div>
        {error && <p className="err small">{error}</p>}
      </div>
    );
  }

  return (
    <div className="card col">
      <h3>Connect to Aupply</h3>
      <p className="muted">
        Aupply finds LinkedIn Easy Apply jobs that fit you and applies to them from this browser, with the profile and answers you keep on
        Aupply. Connect this browser to your Aupply account to start.
      </p>
      <button className="primary" disabled={busy} onClick={start}>
        {busy ? "Starting..." : "Connect to Aupply"}
      </button>
      {note && <p className="small">{note}</p>}
      {error && <p className="err small">{error}</p>}
      <p className="muted small">
        No account yet?{" "}
        <a href={`${state.baseUrl}/signup`} target="_blank" rel="noreferrer">
          Sign up
        </a>
        .
      </p>
    </div>
  );
}
