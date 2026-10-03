import { useEffect, useState } from "react";
import { Nav } from "../components/Nav";
import { Button } from "../components/Button";
import type { WebDevice, WebExtensionInfo } from "../../../src/extension/contract";
import { extensionInfo, listDevices, revokeDevice } from "./api";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");

const STEPS = [
  "Download the zip below and unzip it.",
  "Open chrome://extensions in Chrome.",
  "Turn on Developer mode (top right).",
  "Click Load unpacked and pick the unzipped folder.",
  "Pin Aupply from the puzzle icon, then click it to open its side panel.",
  "Click Connect to Aupply and approve this browser on the page that opens.",
];

/** /extension: download, install steps, and the browsers connected to this account. */
export default function ExtensionPage() {
  const [info, setInfo] = useState<WebExtensionInfo | null>(null);
  const [devices, setDevices] = useState<WebDevice[] | null>(null);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = () => {
    listDevices()
      .then(setDevices)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load your browsers."));
  };
  useEffect(() => {
    extensionInfo().then(setInfo).catch(() => setInfo(null));
    load();
  }, []);

  const revoke = async (id: string) => {
    setRevoking(id);
    setError("");
    try {
      await revokeDevice(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect it.");
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col">
      <Nav light />
      <div className="px-6 md:px-10 py-12 border-b border-white/[0.08] bg-[#0c0c0f]">
        <div className="max-w-4xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/[0.03] mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">Chrome extension</span>
          </div>
          <h1 className="text-display-md font-bold uppercase text-white tracking-tight">Aupply for LinkedIn</h1>
          <p className="text-zinc-400 text-sm mt-2 max-w-2xl leading-relaxed">
            Finds LinkedIn Easy Apply jobs that fit you and applies to them from your own browser, with the profile and answers you keep on
            Aupply. No chat needed. It applies at the pace LinkedIn allows (about a job every minute or two, at most 35 a day) and asks
            you, in its side panel, only what it cannot know.
          </p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 md:px-10 py-10 w-full grid gap-6">
        <div className="rounded-2xl border border-white/[0.1] bg-[#121216] overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] bg-white/[0.03] flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-white">Install</span>
            {info && (
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-white/[0.06] text-zinc-400 border border-white/[0.06]">
                Version {info.latest_version}
              </span>
            )}
          </div>
          <div className="p-6 md:p-8">
            <ol className="text-sm text-zinc-300 space-y-2 mb-6 list-decimal pl-5">
              {STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <Button href={info?.download_url ?? "/downloads/aupply-chrome.zip"} variant="primary" size="lg">
              Download the extension (zip)
            </Button>
            <p className="text-xs text-zinc-500 mt-4 leading-relaxed">
              Chrome only. Until Aupply is on the Chrome Web Store, an update means downloading the zip again and loading it the same way;
              the side panel says when one is needed.
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.1] bg-[#121216] overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] bg-white/[0.03]">
            <span className="text-xs font-bold uppercase tracking-wider text-white">Connected browsers</span>
          </div>
          <div className="p-6 md:p-8">
            {error && <p className="text-accent text-xs mb-4">{error}</p>}
            {!devices ? (
              <p className="text-sm text-zinc-500">Loading...</p>
            ) : !devices.length ? (
              <p className="text-sm text-zinc-500">No browser is connected yet.</p>
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {devices.map((d) => (
                  <li key={d.id} className="py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm text-white font-medium">{d.name}</div>
                      <div className="text-xs text-zinc-500 font-mono">
                        {d.ext_version ? `v${d.ext_version} · ` : ""}connected {when(d.created_at)} · last seen {when(d.last_seen_at)}
                      </div>
                    </div>
                    <Button variant="secondary" size="sm" loading={revoking === d.id} onClick={() => revoke(d.id)}>
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-zinc-500 mt-4">Disconnecting stops that browser at once; it asks to connect again.</p>
          </div>
        </div>

        <div>
          <Button to="/dashboard" variant="ghost" size="sm">
            Back to the dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
