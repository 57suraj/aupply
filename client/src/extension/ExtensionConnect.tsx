import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { Button } from "../components/Button";
import type { WebPairInfo } from "../../../src/extension/contract";
import { decidePairing, pairInfo } from "./api";

/**
 * /extension/connect?code=XXXX-XXXX: approve or deny a browser that asked to connect. The user
 * checks that the code matches the one in the extension's side panel. Signed out: to /login,
 * which brings them back here (as the OAuth consent page does).
 */
export default function ExtensionConnect() {
  const [params] = useSearchParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const code = (params.get("code") || "").toUpperCase();
  const [info, setInfo] = useState<WebPairInfo | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "approved" | "denied">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && !user) navigate(`/login?oauth_return=${encodeURIComponent(`/extension/connect?code=${code}`)}`);
  }, [loading, user, navigate, code]);

  useEffect(() => {
    if (loading || !user) return;
    if (!code) {
      setState("gone");
      return;
    }
    pairInfo(code)
      .then((i) => {
        setInfo(i);
        setState(i.status === "approved" ? "approved" : i.status === "denied" ? "denied" : "ready");
      })
      .catch(() => setState("gone"));
  }, [loading, user, code]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await decidePairing(code, approve);
      setState(r.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (loading || state === "loading") {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg rounded-2xl border border-white/[0.1] bg-[#121216] overflow-hidden shadow-[0_24px_60px_rgba(0,0,0,0.7)]">
        <div className="border-b border-white/[0.08] px-8 py-5 bg-white/[0.02] flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-accent shadow-[0_0_8px_rgba(255,77,0,0.6)]" />
            <span className="text-accent font-bold uppercase text-sm tracking-tight">Aupply</span>
          </Link>
          <span className="text-xs font-mono text-zinc-500 bg-white/[0.04] px-2.5 py-1 rounded-md border border-white/[0.06]">Chrome extension</span>
        </div>

        <div className="px-8 py-8">
          {state === "gone" && (
            <>
              <h1 className="text-2xl font-bold uppercase tracking-tight text-white mb-2">Code not found</h1>
              <p className="text-zinc-400 text-sm leading-relaxed">
                This code is unknown, already used, or expired (codes last 10 minutes). Open the Aupply extension's side panel and click
                Connect to Aupply again.
              </p>
            </>
          )}
          {state === "approved" && (
            <>
              <h1 className="text-2xl font-bold uppercase tracking-tight text-white mb-2">Done</h1>
              <p className="text-zinc-400 text-sm leading-relaxed">
                {info?.device_name ?? "This browser"} is connected to your Aupply account. You can close this tab; the extension's side
                panel carries on.
              </p>
            </>
          )}
          {state === "denied" && (
            <>
              <h1 className="text-2xl font-bold uppercase tracking-tight text-white mb-2">Denied</h1>
              <p className="text-zinc-400 text-sm leading-relaxed">That browser was not connected. You can close this tab.</p>
            </>
          )}
          {state === "ready" && info && (
            <>
              <h1 className="text-2xl font-bold uppercase tracking-tight text-white mb-2">Connect this browser?</h1>
              <p className="text-zinc-400 text-sm mb-6 leading-relaxed">
                <strong className="text-zinc-200">{info.device_name}</strong>
                {info.ext_version ? ` (Aupply extension ${info.ext_version})` : ""} wants to apply to LinkedIn jobs for you with your Aupply
                profile and answers.
              </p>
              <div className="rounded-xl border border-white/[0.08] bg-[#17171d] px-5 py-5 mb-3 text-center">
                <div className="text-xs text-zinc-400 uppercase tracking-wider mb-2 font-medium">Code</div>
                <div className="font-mono text-3xl tracking-[0.2em] text-white">{code}</div>
              </div>
              <p className="text-xs text-zinc-500 mb-6">Make sure this code matches the one in your extension. If it does not, deny it.</p>
              <div className="rounded-xl border border-white/[0.08] bg-[#17171d] px-5 py-3 mb-6 flex justify-between items-center">
                <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">Signed in as</span>
                <span className="text-xs font-mono text-white">{user?.email}</span>
              </div>
              {error && <p className="text-accent text-xs mb-4">{error}</p>}
              <div className="flex items-center gap-3">
                <Button onClick={() => decide(true)} loading={busy} variant="primary" size="lg" className="flex-1">
                  Approve
                </Button>
                <Button onClick={() => decide(false)} disabled={busy} variant="secondary" size="lg">
                  Deny
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
