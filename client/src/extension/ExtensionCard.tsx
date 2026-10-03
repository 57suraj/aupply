import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { listDevices } from "./api";

/** Dashboard card: the Chrome extension, and how many browsers are connected. */
export function ExtensionCard() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    listDevices()
      .then((d) => setCount(d.length))
      .catch(() => setCount(null));
  }, []);
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#121216] overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-white/[0.02]">
        <span className="text-xs text-accent font-bold uppercase tracking-wider">Chrome extension</span>
        {count != null && (
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-white/[0.06] text-zinc-400 border border-white/[0.06]">
            {count} connected
          </span>
        )}
      </div>
      <div className="p-6">
        <h3 className="text-lg font-bold uppercase tracking-tight text-white mb-2">Apply to LinkedIn jobs without a chat</h3>
        <p className="text-zinc-400 text-sm leading-relaxed mb-5">
          The Aupply extension finds LinkedIn Easy Apply jobs that fit you and applies to them from your own browser, with your profile and
          saved answers. It paces itself the way LinkedIn allows and asks you only what it cannot know.
        </p>
        <Button to="/extension" variant="primary" size="md">
          {count ? "Manage the extension" : "Get the extension"}
        </Button>
      </div>
    </div>
  );
}
