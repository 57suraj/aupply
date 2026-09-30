import { useState, useEffect } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { fetchAuthorizationDetails, submitOAuthConsent, type AuthorizationDetails } from "../lib/api";
import { Button } from "../components/Button";

/**
 * OAuth Consent page: /oauth/consent
 *
 * Displayed when Claude initiates an OAuth authorization flow. The backend's
 * /authorize endpoint validates the request and redirects here with a signed
 * `request` token; nothing else in the URL is trusted.
 * The user must be signed in; if not, they are redirected to /login
 * with oauth_return pointing back here.
 *
 * Authorize/Deny POSTs { request, approve } with the Supabase session to
 * /api/oauth/consent, which returns the client's callback URL to navigate to.
 */
export default function OAuthConsent() {
  const [searchParams] = useSearchParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);

  const request = searchParams.get("request") || "";

  // Redirect to login if not authenticated, preserving consent params
  useEffect(() => {
    if (!loading && !user) {
      const returnPath = `/oauth/consent?${searchParams.toString()}`;
      navigate(`/login?oauth_return=${encodeURIComponent(returnPath)}`);
    }
  }, [loading, user, navigate, searchParams]);

  // Load what is being requested (client name, redirect host) once signed in
  useEffect(() => {
    if (loading || !user) return;
    if (!request) {
      setError("Missing authorization request. Start the connection again from Claude.");
      return;
    }
    fetchAuthorizationDetails(request)
      .then(setDetails)
      .catch((e) => setError(e instanceof Error ? e.message : "Invalid authorization request."));
  }, [loading, user, request]);

  const respond = async (approve: boolean) => {
    setError("");
    setAuthorizing(true);
    try {
      const { redirectUrl } = await submitOAuthConsent({ request, approve });
      window.location.href = redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authorization failed.");
      setAuthorizing(false);
    }
  };

  const handleAuthorize = () => respond(true);

  const handleDeny = () => {
    if (details) respond(false);
    else navigate("/dashboard");
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
            Connect {details?.client.name ?? "Claude"}
          </h1>
          <p className="text-zinc-400 text-sm mb-6 leading-relaxed">
            <strong className="text-zinc-200">{details?.client.name ?? "An application"}</strong> is
            requesting access to your Aupply data. It will be able to read and update your job
            search on your behalf.
            {details && (
              <span className="block mt-2 text-xs font-mono text-zinc-500" id="consent-redirect-host">
                You will be returned to {details.redirectHost}
              </span>
            )}
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
                  "Read your profile, work history and education",
                  "Read your resumes and job preferences",
                  "Read and save answers to application questions",
                  "Read and record applications, outcomes and sessions",
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
              disabled={!details}
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
