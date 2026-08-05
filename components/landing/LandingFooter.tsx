import { AppLogo } from "@/components/brand/AppLogo";
import { CookieSettingsButton } from "@/components/analytics/CookieSettingsButton";
import Link from "next/link";
import {
  landingContainerClass,
  landingMutedTextClass,
  landingNavLinkClass,
  landingSubtleTextClass,
} from "@/components/ui/landingSurface";
import { LandingReveal } from "@/components/landing/LandingReveal";
import {
  getSoftwarePagePath,
  softwarePageSlugs,
  softwarePages,
} from "@/lib/softwarePages";

export function LandingFooter() {
  return (
    <footer className="relative z-10 overflow-hidden border-t border-[color:var(--ui-panel-header-border)] bg-[color:var(--bg-app)] py-10">
      <span className="landing-section-glow bottom-0 right-[20%] h-40 w-40 bg-cyan-400/10 [animation-delay:2s]" aria-hidden="true" />
      <div className={`${landingContainerClass} relative`}>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]">
          <LandingReveal variant="left" className="max-w-md">
            <AppLogo className="mb-4" />
            <p className={`${landingMutedTextClass} text-sm leading-6`}>
              A micro-ERP for offline education businesses that need disciplined branch operations before they need another spreadsheet.
            </p>
          </LandingReveal>

          <LandingReveal delay={100} variant="up" className="md:min-w-44">
            <h4 className="mb-4 font-semibold text-[color:var(--text-primary)]">Product</h4>
            <ul className="space-y-3">
              <li><Link href="/#platform" className={landingNavLinkClass}>Platform</Link></li>
              <li><Link href="/#features" className={landingNavLinkClass}>Capabilities</Link></li>
              <li><Link href="/#workflow" className={landingNavLinkClass}>Workflow</Link></li>
            </ul>
          </LandingReveal>

          <LandingReveal delay={180} variant="up" className="md:min-w-44">
            <h4 className="mb-4 font-semibold text-[color:var(--text-primary)]">Software</h4>
            <ul className="space-y-3">
              {softwarePageSlugs.map(slug => (
                <li key={slug}>
                  <Link href={getSoftwarePagePath(slug)} className={landingNavLinkClass}>
                    {softwarePages[slug].shortName}
                  </Link>
                </li>
              ))}
            </ul>
          </LandingReveal>

          <LandingReveal delay={220} variant="up" className="md:min-w-44">
            <h4 className="mb-4 font-semibold text-[color:var(--text-primary)]">Business</h4>
            <ul className="space-y-3">
              <li><Link href="/#pricing" className={landingNavLinkClass}>Pricing</Link></li>
              <li><Link href="/#platform" className={landingNavLinkClass}>Branch control</Link></li>
              <li><Link href="/#features" className={landingNavLinkClass}>AI review</Link></li>
            </ul>
          </LandingReveal>

          <LandingReveal delay={260} variant="up" className="md:min-w-44">
            <h4 className="mb-4 font-semibold text-[color:var(--text-primary)]">Trust</h4>
            <ul className="space-y-3">
              <li><Link href="/privacy" className={landingNavLinkClass}>Privacy Policy</Link></li>
              <li><Link href="/terms" className={landingNavLinkClass}>Terms of Service</Link></li>
              <li><Link href="/refund-policy" className={landingNavLinkClass}>Cancellation and Refund Policy</Link></li>
              <li><Link href="/shipping-delivery-policy" className={landingNavLinkClass}>Shipping and Delivery Policy</Link></li>
              <li><Link href="/contact" className={landingNavLinkClass}>Contact Us</Link></li>
              <li><Link href="/cookies" className={landingNavLinkClass}>Cookies</Link></li>
            </ul>
          </LandingReveal>
        </div>

        <LandingReveal delay={320} className="mt-8 flex flex-col gap-2 border-t border-[color:var(--ui-panel-header-border)] pt-6 text-sm md:flex-row md:items-center md:justify-between">
          <p className={landingSubtleTextClass}>
            &copy; {new Date().getFullYear()} Lab Lords. All rights reserved.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <CookieSettingsButton className={landingSubtleTextClass}>Cookie settings</CookieSettingsButton>
            <p className={landingSubtleTextClass}>Built with precision for education operators.</p>
          </div>
        </LandingReveal>
      </div>
    </footer>
  );
}
