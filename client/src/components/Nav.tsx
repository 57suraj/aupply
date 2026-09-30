import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { Button } from "./Button";

interface NavProps {
  /** Force white text (for dark-background sections) */
  light?: boolean;
}

export function Nav({ light = false }: NavProps) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const navBorder = light ? "border-white/[0.08]" : "border-zinc-800/80";
  const linkColor = light
    ? "text-zinc-400 hover:text-white"
    : "text-zinc-600 hover:text-zinc-950";

  return (
    <header className="sticky top-0 z-40 pt-4 md:pt-6 pb-3 px-4 md:px-8">
      <nav
        className={`max-w-6xl mx-auto flex items-center justify-between px-6 md:px-8 h-16 rounded-2xl backdrop-blur-md transition-all ${
          light
            ? "bg-[#121216]/85 border border-white/[0.08] shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
            : "bg-white/90 border border-zinc-200/80 shadow-[0_4px_24px_rgba(0,0,0,0.06)]"
        }`}
      >
        <Link
          to="/"
          className="flex items-center gap-2.5 group"
          id="nav-logo"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-accent group-hover:scale-125 transition-transform duration-200 shadow-[0_0_10px_rgba(255,77,0,0.6)]" />
          <span className="text-accent font-bold text-xl tracking-tight uppercase">
            Aupply
          </span>
        </Link>

        <div className="flex items-center gap-5 md:gap-7 text-sm font-medium">
          <Link
            to="/pricing"
            className={`${linkColor} transition-colors tracking-tight`}
            id="nav-pricing"
          >
            Pricing
          </Link>

          {user ? (
            <>
              <Link
                to="/dashboard"
                className={`${linkColor} transition-colors tracking-tight`}
                id="nav-dashboard"
              >
                Dashboard
              </Link>
              <Link
                to="/account"
                className={`${linkColor} transition-colors tracking-tight`}
                id="nav-account"
              >
                Account
              </Link>
              <Button
                variant={light ? "ghost" : "outline"}
                size="sm"
                onClick={handleSignOut}
                id="nav-signout"
              >
                Sign out
              </Button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className={`${linkColor} transition-colors tracking-tight`}
                id="nav-login"
              >
                Sign in
              </Link>
              <Button
                to="/signup"
                variant="primary"
                size="sm"
                id="nav-get-started"
                icon={
                  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M3 8a.75.75 0 0 1 .75-.75h6.69L8.22 5.03a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06l2.22-2.22H3.75A.75.75 0 0 1 3 8Z" clipRule="evenodd" />
                  </svg>
                }
              >
                Get Started
              </Button>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
