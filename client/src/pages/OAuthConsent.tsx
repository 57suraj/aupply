import { useState, useEffect } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { submitOAuthConsent } from "../lib/api";
import { Button } from "../components/Button";

/**
 * OAuth Consent page: /oauth/consent
 *
 * Displayed when Claude initiates an OAuth authorization flow.
 * The user must be signed in; if not, they are redirected to /login
 * with oauth_return pointing back here.
 *
 * Once the user clicks "Authorize", we POST their Supabase session token
 * to /api/oauth/consent. The backend issues an auth code and returns the
 * redirect URL (Claude's callback).
 */
export default function OAuthConsent() {
  const [searchParams] = useSearchParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState("");

  const clientId = searchParams.get("client_id") || "";
  const redirectUri = searchParams.get("redirect_uri") || "";
  const state = searchParams.get("state") || "";
  const scope = searchParams.get("scope") || "";

  // Redirect to login if not authenticated, preserving consent params
  useEffect(() => {
    if (!loading && !user) {
      const returnPath = `/oauth/consent?${searchParams.toString()}`;
      navigate(`/login?oauth_return=${encodeURIComponent(returnPath)}`);
    }
  }, [loading, user, navigate, searchParams]);

  const handleAuthorize = async () => {
    setError("");
    setAuthorizing(true);
    try {
      const { redirectUrl } = await submitOAuthConsent({
        clientId,
        redirectUri,
        state,
        scope,
      });
      window.location.href = redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authorization failed.");
      setAuthorizing(false);
    }
  };

  const handleDeny = () => {
    if (redirectUri) {
      const url = new URL(redirectUri);
      url.searchParams.set("error", "access_denied");
      if (state) url.searchParams.set("state", state);
      window.location.href = url.toString();
    } else {
      navigate("/dashboard");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg rounded-2xl border border-white/[0.1] bg-[#121216] overflow-hidden shadow-[0_24px_60px_rgba(0,0,0,0.7)]">
        {/* Header */}
        <div className="border-b border-white/[0.08] px-8 py-5 bg-white/[0.02] flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 group">
            <span className="w-2.5 h-2.5 rounded-full bg-accent shadow-[0_0_8px_rgba(255,77,0,0.6)]" />
            <span className="text-accent font-bold uppercase text-sm tracking-tight">
              Aupply
            </span>
          </Link>
          <span className="text-xs font-mono text-zinc-500 bg-white/[0.04] px-2.5 py-1 rounded-md border border-white/[0.06]">
            OAuth 2.0 Auth
          </span>
        </div>

        <div className="px-8 py-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/[0.03] mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">
              Authorization Request
            </span>
          </div>

          <h1 className="text-2xl font-bold uppercase tracking-tight text-white mb-2">
            Connect Claude
          </h1>
          <p className="text-zinc-400 text-sm mb-6 leading-relaxed">
            Claude is requesting secure remote access to your Aupply MCP server. This allows
            Claude to automatically read and write your job search data.
          </p>

          <div className="rounded-xl border border-white/[0.08] bg-[#17171d] overflow-hidden mb-6">
            <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02] flex justify-between items-center">
              <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">
                Signed in as
              </span>
              <span className="text-xs font-mono text-white" id="consent-user-email">
                {user?.email}
              </span>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-3 font-medium">
                Permissions Requested
              </p>
              <ul className="text-sm text-zinc-300 space-y-2">
                {[
                  "Read candidate profile (skills, summary, bio)",
                  "Read parsed resume details",
                  "Read job preferences and parameters",
                  "Read application log and history",
                  "Save behavioral answers for future applications",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0 shadow-[0_0_6px_rgba(255,77,0,0.6)]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {error && (
            <div className="text-accent text-xs rounded-xl border border-accent/30 bg-accent/[0.08] px-4 py-3 mb-5 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              id="consent-authorize"
              onClick={handleAuthorize}
              loading={authorizing}
              variant="primary"
              size="lg"
              className="flex-1"
              icon={
                <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                  <path fillRule="evenodd" d="M3 8a.75.75 0 0 1 .75-.75h6.69L8.22 5.03a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06l2.22-2.22H3.75A.75.75 0 0 1 3 8Z" clipRule="evenodd" />
                </svg>
              }
            >
              {authorizing ? "Authorizing…" : "Authorize"}
            </Button>
            <Button
              id="consent-deny"
              onClick={handleDeny}
              variant="secondary"
              size="lg"
            >
              Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
