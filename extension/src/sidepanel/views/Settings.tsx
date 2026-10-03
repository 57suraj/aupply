import { useState } from "react";
import type { UiState } from "../../shared/messages";
import { errText, send } from "../send";

export function Settings({ state }: { state: UiState }) {
  const [name, setName] = useState(state.device?.name ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const run = state.run;
  const live = Boolean(run && run.phase !== "done");
  const act = async (f: () => Promise<unknown>, done: string) => {
    try {
      await f();
      setMsg(done);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const allowClicks = async () => {
    // Asked from this click (a user gesture), so Chrome shows its prompt.
    const granted = await chrome.permissions.request({ permissions: ["debugger"] }).catch(() => false);
    await send({ type: "perm/debugger" });
    setMsg(granted ? "Trusted clicks allowed." : "Not allowed.");
  };
  return (
    <div className="col">
      <div className="card col">
        <h2>This browser</h2>
        <div className="field">
          <label>Name on your Aupply account</label>
          <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row">
          <button className="secondary" disabled={!name.trim()} onClick={() => act(() => send({ type: "settings/rename", name: name.trim() }), "Renamed.")}>
            Rename
          </button>
          <button className="danger" disabled={live} onClick={() => act(() => send({ type: "auth/signout" }), "Signed out.")}>
            Sign out
          </button>
        </div>
        {state.me?.user.email && <p className="muted small">Connected as {state.me.user.email}.</p>}
      </div>

      <div className="card col">
        <h2>Trusted clicks</h2>
        <p className="muted small">
          A few forms take a choice only from a real click: a city in a suggestion list, or the "Follow" box. With this allowed, Aupply makes
          that one click itself; Chrome shows a "started debugging this browser" bar for a moment while it does. Without it, Aupply asks you
          to make the click.
        </p>
        {state.debuggerGranted ? (
          <p className="small">Allowed.</p>
        ) : (
          <button className="secondary" onClick={allowClicks}>
            Allow trusted clicks
          </button>
        )}
      </div>

      <div className="card col">
        <h2>Version</h2>
        <p className="small">
          This extension: {state.version}. Latest: {state.me?.versions.latest ?? "unknown"}.
          {state.me && state.me.versions.latest !== state.version && (
            <>
              {" "}
              <a href={`${state.baseUrl}/extension`} target="_blank" rel="noreferrer">
                Get the new version
              </a>
              .
            </>
          )}
        </p>
        <button
          className="secondary"
          onClick={() =>
            act(async () => {
              const text = await send<string>({ type: "log/copy" });
              await navigator.clipboard.writeText(text);
            }, "Debug log copied. It holds times, steps and result codes, never your answers or passwords.")
          }
        >
          Copy debug log
        </button>
      </div>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}
