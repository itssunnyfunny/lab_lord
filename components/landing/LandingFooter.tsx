import { AppLogo } from "@/components/brand/AppLogo";
import { CookieSettingsButton } from "@/components/analytics/CookieSettingsButton";
import Link from "next/link";
import {
  landingContainerClass,
  landingMutedTextClass,
  landingNavLinkClass,
} from "@/components/ui/landingSurface";
import { LandingReveal } from "@/components/landing/LandingReveal";
import {
  getSoftwarePagePath,
  softwarePageSlugs,
  softwarePages,
} from "@/lib/softwarePages";

const footerLinkClass = `${landingNavLinkClass} inline-flex min-h-11 w-full items-center py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]`;

export function LandingFooter() {
  return (
    <footer className="relative z-10 overflow-hidden border-t border-[color:var(--ui-panel-header-border)] bg-[color:var(--bg-app)] py-12">
      <span className="landing-section-glow bottom-0 right-[20%] h-40 w-40 bg-cyan-400/10 [animation-delay:2s]" aria-hidden="true" />
      <div className={`${landingContainerClass} relative`}>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] lg:gap-16">
          <LandingReveal variant="left" className="max-w-md">
            <Link
              href="/"
              aria-label="Lab Lords home"
              className="mb-4 inline-flex rounded-[var(--ui-radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
            >
              <AppLogo />
            </Link>
            <p className={`${landingMutedTextClass} text-sm leading-6`}>
              A micro-ERP for offline education businesses that need disciplined branch operations before they need another spreadsheet.
            </p>
          </LandingReveal>

          <nav aria-label="Footer navigation" className="grid grid-cols-2 gap-x-5 gap-y-9 md:grid-cols-4 md:gap-x-8">
            <LandingReveal delay={100} variant="up">
              <h2 className="mb-2 text-sm font-semibold text-[color:var(--text-primary)]">Product</h2>
              <ul>
                <li><Link href="/#platform" className={footerLinkClass}>Platform</Link></li>
                <li><Link href="/#product-tour" className={footerLinkClass}>Product tour</Link></li>
                <li><Link href="/#features" className={footerLinkClass}>Capabilities</Link></li>
                <li><Link href="/#workflow" className={footerLinkClass}>Workflow</Link></li>
              </ul>
            </LandingReveal>

            <LandingReveal delay={180} variant="up">
              <h2 className="mb-2 text-sm font-semibold text-[color:var(--text-primary)]">Software</h2>
              <ul>
                {softwarePageSlugs.map(slug => (
                  <li key={slug}>
                    <Link href={getSoftwarePagePath(slug)} className={footerLinkClass}>
                      {softwarePages[slug].shortName}
                    </Link>
                  </li>
                ))}
              </ul>
            </LandingReveal>

            <LandingReveal delay={220} variant="up">
              <h2 className="mb-2 text-sm font-semibold text-[color:var(--text-primary)]">Business</h2>
              <ul>
                <li><Link href="/#pricing" className={footerLinkClass}>Pricing</Link></li>
                <li><Link href="/#platform" className={footerLinkClass}>Branch control</Link></li>
                <li><Link href="/#features" className={footerLinkClass}>AI review</Link></li>
                <li><Link href="/support" className={footerLinkClass}>Support</Link></li>
              </ul>
            </LandingReveal>

            <LandingReveal delay={260} variant="up">
              <h2 className="mb-2 text-sm font-semibold text-[color:var(--text-primary)]">Trust &amp; legal</h2>
              <ul>
                <li><Link href="/privacy" className={footerLinkClass}>Privacy Policy</Link></li>
                <li><Link href="/terms" className={footerLinkClass}>Terms of Service</Link></li>
                <li><Link href="/refund-policy" className={footerLinkClass}>Cancellation and Refund Policy</Link></li>
                <li><Link href="/shipping-delivery-policy" className={footerLinkClass}>Shipping and Delivery Policy</Link></li>
                <li><Link href="/contact" className={footerLinkClass}>Contact Us</Link></li>
                <li><Link href="/cookies" className={footerLinkClass}>Cookies</Link></li>
              </ul>
            </LandingReveal>
          </nav>
        </div>

        <LandingReveal delay={320} className="mt-10 flex flex-col gap-3 border-t border-[color:var(--ui-panel-header-border)] pt-6 text-sm md:flex-row md:items-center md:justify-between">
          <p className={landingMutedTextClass}>
            &copy; {new Date().getFullYear()} Lab Lords. All rights reserved.
          </p>
          <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-4">
            <CookieSettingsButton className={`${landingMutedTextClass} inline-flex min-h-11 items-center rounded-[var(--ui-radius-control)] py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]`}>
              Cookie settings
            </CookieSettingsButton>
            <p className={landingMutedTextClass}>Built with precision for education operators.</p>
          </div>
        </LandingReveal>
      </div>
    </footer>
  );
}
