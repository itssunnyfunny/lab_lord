import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { AppLogo } from "@/components/brand/AppLogo";
import {
  landingContainerClass,
  landingNavLinkClass,
  landingPrimaryButtonClass,
} from "@/components/ui/landingSurface";
import {
  accountMenuClerkAppearance,
  accountProfileClerkAppearance,
} from "@/components/ui/entrySurface";

const landingNavItems = [
  { label: "Platform", href: "#platform" },
  { label: "Software", href: "#software" },
  { label: "Workflow", href: "#workflow" },
  { label: "Pricing", href: "#pricing" },
] as const;

export function LandingNavbar({
  isSignedIn,
  onSignInClick,
  onWorkspaceClick,
}: {
  isSignedIn: boolean;
  onSignInClick: (source: string) => void;
  onWorkspaceClick: (source: string) => void;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-[color:var(--ui-panel-header-border)] bg-[color:var(--bg-app)]/95 backdrop-blur-xl">
      <div className={`${landingContainerClass} flex h-16 items-center justify-between gap-4`}>
        <Link
          href="/"
          aria-label="Lab Lords home"
          className="landing-reveal shrink-0 rounded-[var(--ui-radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
        >
          <AppLogo subtitleClassName="hidden sm:block" />
        </Link>

        <nav aria-label="Primary navigation" className="landing-reveal hidden items-center gap-8 [animation-delay:120ms] md:flex">
          {landingNavItems.map(item => (
            <Link key={item.href} href={item.href} className={landingNavLinkClass}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {!isSignedIn && (
            <button
              type="button"
              className="hidden min-h-11 items-center rounded-[var(--ui-radius-control)] px-2 text-sm font-medium text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] sm:inline-flex"
              onClick={() => onSignInClick("landing_nav_sign_in")}
            >
              Sign in
            </button>
          )}
          <button
            type="button"
            onClick={() => onWorkspaceClick("landing_nav_workspace")}
            className={`${landingPrimaryButtonClass} landing-cta-shine px-3 sm:px-4`}
          >
            {isSignedIn ? (
              <>
                <span className="hidden sm:inline">Open workspace</span>
                <span className="sm:hidden">Open</span>
              </>
            ) : (
              <>
                <span className="hidden sm:inline">Start with your branch</span>
                <span className="sm:hidden">Start</span>
              </>
            )}
            <ArrowRight size={14} />
          </button>
          {isSignedIn && (
            <div className="hidden sm:block">
              <UserButton
                appearance={accountMenuClerkAppearance}
                userProfileMode="modal"
                userProfileProps={{ appearance: accountProfileClerkAppearance }}
              />
            </div>
          )}
          <details className="group md:hidden">
            <summary
              className="inline-flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] text-[color:var(--ui-button-secondary-text)] transition-colors hover:border-[color:var(--ui-button-secondary-hover-border)] hover:bg-[color:var(--ui-button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] [&::-webkit-details-marker]:hidden"
              aria-controls="landing-mobile-navigation"
            >
              <Menu size={20} className="group-open:hidden" aria-hidden="true" />
              <X size={20} className="hidden group-open:block" aria-hidden="true" />
              <span className="sr-only">Navigation menu</span>
            </summary>

            <div
              id="landing-mobile-navigation"
              className="fixed inset-x-0 top-16 border-t border-[color:var(--ui-panel-header-border)] bg-[color:var(--bg-app)] px-4 py-3 shadow-[0_20px_50px_rgba(0,0,0,0.45)]"
            >
              <nav aria-label="Mobile navigation" className="mx-auto grid max-w-7xl grid-cols-2 gap-2">
                {landingNavItems.map(item => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={event => event.currentTarget.closest("details")?.removeAttribute("open")}
                    className="inline-flex min-h-11 items-center rounded-[var(--ui-radius-control)] px-3 text-sm font-semibold text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--ui-button-quiet-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
                  >
                    {item.label}
                  </Link>
                ))}
                {!isSignedIn && (
                  <button
                    type="button"
                    className="col-span-2 inline-flex min-h-11 items-center rounded-[var(--ui-radius-control)] px-3 text-sm font-semibold text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--ui-button-quiet-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] sm:hidden"
                    onClick={event => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      onSignInClick("landing_mobile_nav_sign_in");
                    }}
                  >
                    Sign in
                  </button>
                )}
                {isSignedIn && (
                  <Link
                    href="/account"
                    onClick={event => event.currentTarget.closest("details")?.removeAttribute("open")}
                    className="col-span-2 inline-flex min-h-11 items-center rounded-[var(--ui-radius-control)] px-3 text-sm font-semibold text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--ui-button-quiet-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] sm:hidden"
                  >
                    Account settings
                  </Link>
                )}
              </nav>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
