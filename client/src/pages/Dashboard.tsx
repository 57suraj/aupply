import React, { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { createCheckoutSession } from "../lib/api";
import { Nav } from "../components/Nav";
import { Button } from "../components/Button";

const mcpUrl =
  (import.meta.env.VITE_MCP_BASE_URL as string | undefined) ||
  window.location.origin;

function Section({
  label,
  title,
  children,
  placeholder,
}: {
  label: string;
  title: string;
  children?: React.ReactNode;
  placeholder?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#121216] overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-white/[0.02]">
        <span className="text-xs text-accent font-bold uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="p-6">
        <h3 className="text-lg font-bold uppercase tracking-tight text-white mb-2">{title}</h3>
        {children || (
          <p className="text-zinc-500 text-sm leading-relaxed">{placeholder}</p>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [copying, setCopying] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [subError, setSubError] = useState("");

  const fullMcpUrl = `${mcpUrl}/mcp`;

  const copyMcpUrl = async () => {
    await navigator.clipboard.writeText(fullMcpUrl);
    setCopying(true);
    setTimeout(() => setCopying(false), 2000);
  };

  const handleSubscribe = async () => {
    setSubError("");
    setSubscribing(true);
    try {
      const { url } = await createCheckoutSession();
      window.location.href = url;
    } catch (e) {
      setSubError(e instanceof Error ? e.message : "Failed to start checkout.");
      setSubscribing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col">
      <Nav light />

      {/* Header */}
      <div className="px-6 md:px-10 py-12 border-b border-white/[0.08] bg-[#0c0c0f]">
        <div className="max-w-6xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/[0.03] mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">
              Control Panel
            </span>
          </div>
          <h1 className="text-display-md font-bold uppercase text-white tracking-tight">
            Your job search
          </h1>
          <p className="text-zinc-400 text-sm mt-2 font-mono">{user?.email}</p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 md:px-10 py-10 w-full grid md:grid-cols-2 gap-6 flex-1">

        {/* ── Claude connection ──────────────────────────────── */}
        <div className="md:col-span-2 rounded-2xl border border-white/[0.1] bg-[#121216] overflow-hidden shadow-[0_12px_36px_rgba(0,0,0,0.5)]">
          <div className="px-6 py-4 border-b border-white/[0.08] bg-white/[0.03] flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-accent shadow-[0_0_8px_rgba(255,77,0,0.6)]" />
              <span className="text-xs font-bold uppercase tracking-wider text-white">
                Claude MCP Connector
              </span>
            </div>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-white/[0.06] text-zinc-400 border border-white/[0.06]">
              REMOTE SSE / HTTP
            </span>
          </div>

          <div className="p-6 md:p-8">
            <p className="text-sm text-zinc-400 mb-6 max-w-2xl leading-relaxed">
              Add Aupply to Claude as a remote MCP connector. Copy the server URL below
              and paste it into{" "}
              <strong className="text-zinc-200">
                Claude → Settings → Integrations → Add custom connector
              </strong>
              . Claude will authenticate via OAuth and sync automatically.
            </p>

            <label className="block text-xs text-zinc-400 uppercase tracking-wider mb-2 font-medium">
              Your Remote MCP Endpoint
            </label>

            <div className="flex flex-col sm:flex-row items-stretch gap-2 p-1.5 rounded-xl bg-[#09090b] border border-white/[0.1]">
              <code
                id="mcp-url-display"
                className="flex-1 font-mono text-sm px-4 py-2.5 text-zinc-300 overflow-x-auto whitespace-nowrap self-center"
              >
                {fullMcpUrl}
              </code>
              <Button
                id="copy-mcp-url"
                onClick={copyMcpUrl}
                variant={copying ? "white" : "primary"}
                size="sm"
                icon={
                  copying ? (
                    <svg className="w-3.5 h-3.5 text-emerald-600" viewBox="0 0 16 16" fill="currentColor">
                      <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                      <path fillRule="evenodd" d="M11 2H5a2 2 0 0 0-2 2v7a1 1 0 1 0 2 0V4a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H8a1 1 0 1 0 0 2h3a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z" clipRule="evenodd" />
                      <path fillRule="evenodd" d="M1 9.5A1.5 1.5 0 0 1 2.5 8h4A1.5 1.5 0 0 1 8 9.5v4A1.5 1.5 0 0 1 6.5 15h-4A1.5 1.5 0 0 1 1 13.5v-4Zm1.5 0a.5.5 0 0 0-.5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 0-.5-.5h-4Z" clipRule="evenodd" />
                    </svg>
                  )
                }
              >
                {copying ? "Copied" : "Copy URL"}
              </Button>
            </div>
          </div>
        </div>

        {/* ── Profile sections (placeholders) ───────────────── */}
        <Section
          label="Profile"
          title="Resume"
          placeholder="Resume storage coming in next phase. Your resume and skills will be accessible to Claude through the getCandidateProfile and getResume MCP tools."
        />

        <Section
          label="Profile"
          title="Preferences"
          placeholder="Target preferences coming in next phase. Set your desired roles, compensation, stack preferences, and locations for getJobPreferences."
        />

        <Section
          label="History"
          title="Saved Answers"
          placeholder="Saved answers coming in next phase. Behavioral and application answers will be automatically retrieved and stored via saveAnswer."
        />

        <Section
          label="History"
          title="Application History"
          placeholder="Application records coming in next phase. Track all roles Claude has researched or applied to via getApplicationHistory."
        />

        {/* ── Subscription ──────────────────────────────────── */}
        <div className="md:col-span-2 rounded-2xl border border-white/[0.1] bg-[#121216] overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] bg-white/[0.02]">
            <span className="text-xs text-accent font-bold uppercase tracking-wider">
              Subscription Status
            </span>
          </div>
          <div className="p-6 md:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <h3 className="text-lg font-bold uppercase text-white mb-1">
                Active MCP Tier
              </h3>
              <p className="text-sm text-zinc-400 max-w-md leading-relaxed">
                Aupply requires an active subscription to process MCP tool requests from Claude.
                Subscribe for $2/month with instant activation.
              </p>
              {subError && (
                <p className="text-accent text-xs mt-3 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  {subError}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <Button
                id="dashboard-subscribe"
                onClick={handleSubscribe}
                loading={subscribing}
                variant="primary"
                size="md"
              >
                {subscribing ? "Loading…" : "Subscribe ($2/mo)"}
              </Button>
              <Button
                to="/account"
                id="dashboard-account-link"
                variant="secondary"
                size="md"
              >
                Account
              </Button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
