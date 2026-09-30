import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Nav } from "../components/Nav";
import { Button } from "../components/Button";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Detect if this login is part of an OAuth flow
  const searchParams = new URLSearchParams(location.search);
  const oauthReturn = searchParams.get("oauth_return");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    // If we arrived here via OAuth flow, return to the consent page
    if (oauthReturn) {
      navigate(oauthReturn);
    } else {
      navigate(from, { replace: true });
    }
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col">
      <Nav light />

      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
          <div className="rounded-2xl border border-white/[0.1] bg-[#121216] p-8 md:p-10 shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/[0.03] mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">
                Authentication
              </span>
            </div>

            <h1 className="text-2xl md:text-3xl font-bold uppercase tracking-tight text-white mb-2">
              Sign in
            </h1>
            <p className="text-zinc-400 text-xs mb-8">
              Access your MCP configuration and profile
            </p>

            <form onSubmit={handleSubmit} className="space-y-5" id="login-form">
              <div>
                <label
                  htmlFor="login-email"
                  className="block text-xs text-zinc-400 uppercase tracking-wider mb-2 font-medium"
                >
                  Email
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-[#18181d] border border-white/[0.08] text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all placeholder:text-zinc-600 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label
                  htmlFor="login-password"
                  className="block text-xs text-zinc-400 uppercase tracking-wider mb-2 font-medium"
                >
                  Password
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-[#18181d] border border-white/[0.08] text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all placeholder:text-zinc-600 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]"
                  placeholder="••••••••"
                />
              </div>

              {error && (
                <div className="text-accent text-xs rounded-xl border border-accent/30 bg-accent/[0.08] px-4 py-3 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                id="login-submit"
                type="submit"
                loading={loading}
                variant="primary"
                size="lg"
                fullWidth
                icon={
                  <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M3 8a.75.75 0 0 1 .75-.75h6.69L8.22 5.03a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06l2.22-2.22H3.75A.75.75 0 0 1 3 8Z" clipRule="evenodd" />
                  </svg>
                }
              >
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>

            <div className="mt-8 pt-6 border-t border-white/[0.07] text-center text-xs text-zinc-400">
              Don't have an account?{" "}
              <Link to="/signup" className="text-white hover:text-accent font-medium transition-colors">
                Create one
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
