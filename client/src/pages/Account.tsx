import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { fetchSubscription, createBillingPortalSession } from "../lib/api";
import { Nav } from "../components/Nav";
import { Button } from "../components/Button";

interface Subscription {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export default function Account() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    fetchSubscription()
      .then(setSub)
      .catch(() => setSub(null))
      .finally(() => setSubLoading(false));
  }, []);

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const handleBillingPortal = async () => {
    setPortalLoading(true);
    try {
      const { url } = await createBillingPortalSession();
      window.location.href = url;
    } catch {
      setPortalLoading(false);
    }
  };

  const isActive = sub?.status === "active";

  const formatDate = (iso: string | null) => {
    if (!iso) return "None";
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col">
      <Nav light />

      {/* Header */}
      <div className="px-6 md:px-10 py-12 border-b border-white/[0.08] bg-[#0c0c0f]">
        <div className="max-w-4xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/[0.03] mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">
              Settings & Billing
            </span>
          </div>
          <h1 className="text-display-md font-bold uppercase text-white tracking-tight">Your account</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 md:px-10 py-10 w-full space-y-6 flex-1">

        {/* Email */}
        <div className="rounded-2xl border border-white/[0.1] bg-[#121216] overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] bg-white/[0.02]">
            <span className="text-xs text-accent font-bold uppercase tracking-wider">
              Profile
            </span>
          </div>
          <div className="px-6 py-6 flex flex-col sm:flex-row justify-between sm:items-center gap-4">
            <div>
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1 font-medium">
                Email Address
              </p>
              <p className="text-sm font-mono text-white" id="account-email">
                {user?.email}
              </p>
            </div>
            <span className="text-xs font-mono text-zinc-500 bg-white/[0.04] px-3 py-1.5 rounded-lg border border-white/[0.06] self-start sm:self-auto">
              Authenticated
            </span>
          </div>
        </div>

        {/* Subscription */}
        <div className="rounded-2xl border border-white/[0.1] bg-[#121216] overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] bg-white/[0.02] flex items-center justify-between">
            <span className="text-xs text-accent font-bold uppercase tracking-wider">
              Subscription
            </span>
            <span className="text-xs font-mono text-zinc-500">Stripe Billing</span>
          </div>

          {subLoading ? (
            <div className="px-6 py-10 flex items-center gap-3 text-zinc-400 text-sm">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              Loading subscription status…
            </div>
          ) : (
            <div className="px-6 py-6 space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 pb-6 border-b border-white/[0.06]">
                <div>
                  <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2 font-medium">
                    Status
                  </p>
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08]">
                    <div
                      className={`w-1.5 h-1.5 rounded-full ${
                        isActive ? "bg-accent shadow-[0_0_6px_rgba(255,77,0,0.7)]" : "bg-zinc-600"
                      }`}
                    />
                    <span
                      id="account-sub-status"
                      className={`text-xs font-semibold uppercase tracking-wider ${
                        isActive ? "text-white" : "text-zinc-400"
                      }`}
                    >
                      {sub?.status ?? "No subscription"}
                    </span>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2 font-medium">
                    Price
                  </p>
                  <p className="text-sm font-semibold text-white mt-1" id="account-sub-price">
                    {isActive ? "$2 / month" : "None"}
                  </p>
                </div>

                <div>
                  <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2 font-medium">
                    {sub?.cancelAtPeriodEnd ? "Cancels on" : "Renews on"}
                  </p>
                  <p className="text-sm font-mono text-zinc-300 mt-1" id="account-sub-renewal">
                    {formatDate(sub?.currentPeriodEnd ?? null)}
                  </p>
                </div>
              </div>

              <div>
                {isActive ? (
                  <Button
                    id="account-billing-portal"
                    onClick={handleBillingPortal}
                    loading={portalLoading}
                    variant="secondary"
                    size="md"
                    icon={
                      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                        <path fillRule="evenodd" d="M3 8a.75.75 0 0 1 .75-.75h6.69L8.22 5.03a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06l2.22-2.22H3.75A.75.75 0 0 1 3 8Z" clipRule="evenodd" />
                      </svg>
                    }
                  >
                    {portalLoading ? "Loading…" : "Manage Billing & Invoices"}
                  </Button>
                ) : (
                  <Button
                    id="account-subscribe"
                    onClick={() => navigate("/dashboard")}
                    variant="primary"
                    size="md"
                    icon={
                      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                        <path fillRule="evenodd" d="M3 8a.75.75 0 0 1 .75-.75h6.69L8.22 5.03a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06l2.22-2.22H3.75A.75.75 0 0 1 3 8Z" clipRule="evenodd" />
                      </svg>
                    }
                  >
                    Subscribe ($2/mo)
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sign out */}
        <div className="pt-4 flex justify-between items-center">
          <Button
            id="account-signout"
            onClick={handleSignOut}
            variant="ghost"
            size="sm"
          >
            Sign out of account →
          </Button>
        </div>
      </div>
    </div>
  );
}
