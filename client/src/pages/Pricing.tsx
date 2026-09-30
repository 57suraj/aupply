import { Link } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Button } from "../components/Button";

export default function Pricing() {
  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col">
      <Nav light />

      {/* Header */}
      <section className="px-6 md:px-10 pt-16 pb-12 border-b border-white/[0.08]">
        <div className="max-w-4xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/[0.03] mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">
              Pricing Plans
            </span>
          </div>
          <h1 className="text-display-lg font-bold uppercase text-white tracking-tight">
            One plan.
            <br />
            <span className="text-zinc-500">One price.</span>
          </h1>
        </div>
      </section>

      {/* Plan */}
      <section className="px-6 md:px-10 py-20 flex-1">
        <div className="max-w-md mx-auto">
          <div className="rounded-2xl border border-white/[0.12] bg-[#121216] overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
            <div className="border-b border-white/[0.08] p-8 md:p-10 bg-gradient-to-b from-white/[0.03] to-transparent">
              <span className="text-xs uppercase font-bold tracking-widest text-accent mb-4 block">
                Standard Membership
              </span>
              <div className="flex items-baseline gap-1 mb-3">
                <span className="text-accent text-3xl font-bold">$</span>
                <span className="text-6xl md:text-7xl font-black leading-none text-white tracking-tight">2</span>
                <span className="text-zinc-400 text-lg font-medium ml-1">/ month</span>
              </div>
              <p className="text-zinc-400 text-xs">Billed monthly. Cancel anytime with no penalty.</p>
            </div>

            <div className="p-8 md:p-10 space-y-4">
              {[
                "Remote MCP server for Claude",
                "Secure ATS-compliant resume storage",
                "Target job preferences & salary parameters",
                "Application tracking & submission logs",
                "Stored questions & verified answers",
                "Standard OAuth 2.0 encrypted connection",
              ].map((feature) => (
                <div key={feature} className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0 shadow-[0_0_6px_rgba(255,77,0,0.6)]" />
                  <span className="text-sm text-zinc-300">{feature}</span>
                </div>
              ))}
            </div>

            <div className="px-8 pb-8 md:px-10 md:pb-10">
              <Button
                to="/signup"
                id="pricing-page-cta"
                variant="primary"
                size="lg"
                fullWidth
                icon={
                  <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M3 8a.75.75 0 0 1 .75-.75h6.69L8.22 5.03a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06l2.22-2.22H3.75A.75.75 0 0 1 3 8Z" clipRule="evenodd" />
                  </svg>
                }
              >
                Get Started
              </Button>
            </div>
          </div>

          <p className="mt-8 text-zinc-500 text-xs text-center max-w-sm mx-auto leading-relaxed">
            Aupply is an MCP server for Claude. It extends what Claude can do by giving it authenticated access to your job-search profile.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.08] px-6 md:px-10 py-8 flex justify-between items-center text-xs text-zinc-500 bg-[#09090b]">
        <Link to="/" className="text-accent font-bold text-sm uppercase tracking-tight">
          Aupply
        </Link>
        <p>© {new Date().getFullYear()} Aupply. All rights reserved.</p>
      </footer>
    </div>
  );
}
