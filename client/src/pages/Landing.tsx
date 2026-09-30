import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Nav } from "../components/Nav";
import { Button } from "../components/Button";

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
};

export default function Landing() {
  return (
    <div className="bg-[#09090b] text-zinc-100 min-h-screen selection:bg-accent selection:text-white">
      <Nav light />

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="relative px-6 md:px-10 pt-20 pb-28 md:pt-32 md:pb-36 border-b border-white/[0.08] overflow-hidden">
        {/* Ambient background glow using subtle shades of black & orange accent */}
        <div 
          aria-hidden="true"
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-gradient-to-b from-accent/[0.12] via-accent/[0.03] to-transparent blur-3xl pointer-events-none rounded-full"
        />

        <div className="max-w-6xl mx-auto relative z-10">
          <motion.div
            initial="initial"
            animate="animate"
            transition={{ staggerChildren: 0.08 }}
          >
            <motion.div
              variants={fadeUp}
              transition={{ duration: 0.5 }}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/10 bg-white/[0.03] mb-8 shadow-sm"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="text-zinc-300 text-xs font-semibold uppercase tracking-wider">
                Remote MCP Server for Claude
              </span>
            </motion.div>

            <motion.h1
              variants={fadeUp}
              transition={{ duration: 0.6 }}
              className="text-display-lg md:text-display-xl uppercase font-bold text-white tracking-tight leading-[0.92]"
            >
              Let Claude apply to
            </motion.h1>
            <motion.h1
              variants={fadeUp}
              transition={{ duration: 0.6 }}
              className="text-display-lg md:text-display-xl uppercase font-bold text-zinc-300 tracking-tight leading-[0.92]"
            >
              1,000+ jobs every month
            </motion.h1>
            <motion.h1
              variants={fadeUp}
              transition={{ duration: 0.6 }}
              className="text-display-lg md:text-display-xl uppercase font-bold text-accent tracking-tight leading-[0.92] mb-10"
            >
              based on your preferences.
            </motion.h1>

            <motion.p
              variants={fadeUp}
              transition={{ duration: 0.5 }}
              className="max-w-2xl text-zinc-400 text-lg md:text-xl leading-relaxed mb-10 font-normal"
            >
              Connect Aupply to Claude once. Auto-apply across LinkedIn, Wellfound,
              and Naukri with zero fake data, and save all your application stats in real time.
            </motion.p>

            <motion.div
              variants={fadeUp}
              transition={{ duration: 0.5 }}
              className="flex flex-wrap items-center gap-4"
            >
              <Button
                to="/signup"
                id="hero-cta"
                variant="primary"
                size="lg"
                icon={
                  <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M3 8a.75.75 0 0 1 .75-.75h6.69L8.22 5.03a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06l2.22-2.22H3.75A.75.75 0 0 1 3 8Z" clipRule="evenodd" />
                  </svg>
                }
              >
                Get Started
              </Button>

              <Button
                to="/pricing"
                id="hero-pricing-link"
                variant="secondary"
                size="lg"
              >
                $2 / month
              </Button>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────── */}
      <section className="px-6 md:px-10 py-24 md:py-32 border-b border-white/[0.08] bg-[#0c0c0f]">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center gap-3 mb-12">
            <span className="w-2 h-2 rounded-sm bg-accent" />
            <p className="text-zinc-400 text-xs font-bold uppercase tracking-widest">
              How it works
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {[
              {
                n: "01",
                title: "Connect to Claude",
                body: "Add Aupply as a remote MCP connector in Claude. One URL. Instant handshake.",
              },
              {
                n: "02",
                title: "Build your profile",
                body: "Upload your resume, set target preferences, and store verified answers once.",
              },
              {
                n: "03",
                title: "Tell Claude what you want",
                body: "Describe the role you're looking for. Claude accesses your profile automatically.",
              },
              {
                n: "04",
                title: "Let Claude work",
                body: "Claude runs tailored applications and queries using your data with zero manual copy-paste.",
              },
            ].map((step) => (
              <div
                key={step.n}
                className="group relative p-8 md:p-10 rounded-2xl bg-[#121216] border border-white/[0.07] hover:border-white/[0.18] transition-all duration-300 hover:shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
              >
                <div className="flex items-center justify-between mb-6">
                  <span className="text-accent font-mono text-xs font-bold px-2.5 py-1 rounded-md bg-accent/[0.1] border border-accent/20">
                    {step.n}
                  </span>
                  <div className="w-2 h-2 rounded-full bg-zinc-800 group-hover:bg-accent transition-colors duration-300" />
                </div>
                <h3 className="text-xl md:text-2xl font-bold mb-3 uppercase tracking-tight text-white group-hover:text-zinc-100">
                  {step.title}
                </h3>
                <p className="text-zinc-400 text-sm md:text-base leading-relaxed">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Data section ──────────────────────────────────────── */}
      <section className="px-6 md:px-10 py-24 md:py-32 border-b border-white/[0.08] bg-[#09090b]">
        <div className="max-w-6xl mx-auto">
          <p className="text-accent text-xs font-bold uppercase tracking-widest mb-6">
            Your data
          </p>
          <h2 className="text-display-lg font-bold uppercase mb-16 max-w-3xl text-white">
            Everything Claude needs. <span className="text-zinc-500">Nothing it doesn't.</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { title: "Resume", desc: "Parsed structured markdown and ATS-ready context" },
              { title: "Preferences", desc: "Target salary, seniority, location, and stack" },
              { title: "Application History", desc: "Real-time records of every role Claude tackled" },
              { title: "Saved Answers", desc: "Reusable responses for recurring behavioral queries" },
            ].map((item) => (
              <div
                key={item.title}
                className="p-7 rounded-xl bg-zinc-900/50 border border-white/[0.07] hover:border-accent/40 transition-colors duration-200"
              >
                <div className="w-2 h-2 rounded-full bg-accent mb-6 shadow-[0_0_8px_rgba(255,77,0,0.5)]" />
                <p className="text-white font-bold text-base uppercase tracking-tight mb-2">
                  {item.title}
                </p>
                <p className="text-zinc-400 text-xs leading-relaxed">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ───────────────────────────────────────────── */}
      <section className="px-6 md:px-10 py-24 md:py-32 border-b border-white/[0.08] bg-[#0d0d10]">
        <div className="max-w-6xl mx-auto">
          <p className="text-accent text-xs font-bold uppercase tracking-widest mb-10">
            Transparent Pricing
          </p>

          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-12">
            <div>
              <h2 className="text-display-lg font-bold uppercase leading-none mb-3 text-white">
                One plan.
              </h2>
              <h2 className="text-display-lg font-bold uppercase leading-none text-zinc-500">
                One price.
              </h2>
              <p className="mt-8 text-zinc-400 text-base max-w-md leading-relaxed">
                Unlock full MCP tool access. Instant connection, automatic background sync, zero commitments.
              </p>
            </div>

            <div className="rounded-2xl border border-white/[0.12] bg-[#141418] p-8 md:p-10 lg:w-[420px] shadow-[0_16px_48px_rgba(0,0,0,0.6)]">
              <div className="flex items-baseline gap-1.5 mb-2">
                <span className="text-accent text-3xl font-bold">$</span>
                <span className="text-6xl md:text-7xl font-black leading-none text-white tracking-tight">2</span>
                <span className="text-zinc-400 text-lg font-medium ml-1">/ month</span>
              </div>
              <p className="text-zinc-400 text-xs mb-8">
                No contract. Cancel anytime in one click.
              </p>

              <div className="space-y-3 mb-8 text-xs text-zinc-300">
                <div className="flex items-center gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                  <span>Full 5-tool Remote MCP server</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                  <span>OAuth 2.0 Claude authentication</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                  <span>Encrypted profile and answer storage</span>
                </div>
              </div>

              <Button
                to="/signup"
                id="pricing-cta"
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
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="px-6 md:px-10 py-10 bg-[#09090b] text-zinc-500 text-xs">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-accent" />
            <span className="text-white font-bold text-sm uppercase tracking-tight">Aupply</span>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-500">MCP Infrastructure for AI Job Automation</span>
          </div>
          <div className="flex gap-6">
            <Link to="/pricing" className="hover:text-white transition-colors">
              Pricing
            </Link>
            <Link to="/login" className="hover:text-white transition-colors">
              Sign in
            </Link>
          </div>
          <p>© {new Date().getFullYear()} Aupply. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
