import { useCallback, useEffect, useState } from "react";
import type { SwBroadcast, UiState } from "../shared/messages";
import { errText, send } from "./send";
import { Connect } from "./views/Connect";
import { Decisions } from "./views/Decisions";
import { Home } from "./views/Home";
import { Questions } from "./views/Questions";
import { Review } from "./views/Review";
import { Settings } from "./views/Settings";
import { Setup } from "./views/Setup";

type View = "home" | "questions" | "decisions" | "review" | "settings";

export function App() {
  const [state, setState] = useState<UiState | null>(null);
  const [view, setView] = useState<View>("home");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await send<UiState>({ type: "state/get" }));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onMsg = (m: SwBroadcast) => {
      if (m?.type === "state/changed") setState(m.state);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const t = setInterval(() => void refresh(), 30_000);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      clearInterval(t);
    };
  }, [refresh]);

  if (!state) return <div className="muted">{error ?? "Loading..."}</div>;

  const me = state.me;
  const badges = {
    questions: me?.open_questions ?? 0,
    decisions: me?.linkedin.queue.decisions ?? 0,
    review: me?.provisional_to_review ?? 0,
  };
  const tab = (v: View, label: string, n = 0) => (
    <button key={v} className={`tab ${view === v ? "on" : ""}`} onClick={() => setView(v)}>
      {label}
      {n > 0 && <span className="badge">{n}</span>}
    </button>
  );

  return (
    <>
      <div className="top">
        <div className="logo">
          <b>A</b>
          <h1>Aupply</h1>
        </div>
        <span className="pill">LinkedIn</span>
      </div>
      {state.updateRequired && (
        <div className="note bad">
          Update required: this version ({state.version}) is out of date.{" "}
          <a href={state.updateRequired.download_url || `${state.baseUrl}/extension`} target="_blank" rel="noreferrer">
            Download the new version
          </a>
          , unzip it, and load it again on chrome://extensions.
        </div>
      )}
      {error && <div className="note bad">{error}</div>}
      {!state.connected ? (
        <Connect state={state} />
      ) : me && me.setup_gaps.length ? (
        <Setup state={state} onDone={refresh} />
      ) : (
        <>
          <div className="tabs">
            {tab("home", "Home")}
            {tab("questions", "Questions", badges.questions)}
            {tab("decisions", "Decisions", badges.decisions)}
            {tab("review", "Review", badges.review)}
            {tab("settings", "Settings")}
          </div>
          {view === "home" && <Home state={state} />}
          {view === "questions" && <Questions />}
          {view === "decisions" && <Decisions />}
          {view === "review" && <Review />}
          {view === "settings" && <Settings state={state} />}
        </>
      )}
    </>
  );
}
