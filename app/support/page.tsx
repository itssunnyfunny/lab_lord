import type { Metadata } from "next";
import { LifeBuoy, Mail } from "lucide-react";
import { BugReportForm } from "@/components/feedback/BugReportForm";
import { LegalPage, type LegalSection } from "@/components/legal/LegalPage";
import { landingMutedTextClass } from "@/components/ui/landingSurface";
import { absoluteUrl, siteConfig } from "@/lib/site";

const sections: LegalSection[] = [
  {
    title: "Contact support",
    body: "For account, billing, product, privacy, or operational issues, email support with your workspace name and a clear description of the issue.",
  },
  {
    title: "What to include",
    items: [
      "The page or workflow where the issue happened.",
      "What you expected and what happened instead.",
      "Screenshots, error text, browser details, and timestamps when available.",
    ],
  },
];

const supportDescription = "Contact Lab Lords support or send a bug report with page, browser, and timestamp context.";

export const metadata: Metadata = {
  title: "Support",
  description: supportDescription,
  alternates: {
    canonical: absoluteUrl("/support"),
  },
  openGraph: {
    type: "website",
    url: absoluteUrl("/support"),
    siteName: siteConfig.name,
    title: "Lab Lords Support",
    description: supportDescription,
  },
  twitter: {
    card: "summary",
    title: "Lab Lords Support",
    description: supportDescription,
  },
};

export default function SupportPage() {
  return (
    <LegalPage
      eyebrow="Support"
      title="Contact and bug reports"
      description="Reach support directly or open a bug report email with useful diagnostic context."
      sections={sections}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(320px,1fr)]">
        <div className="rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] p-5 shadow-[var(--ui-panel-shadow)]">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]">
              <LifeBuoy size={18} />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">Support email</h2>
              <p className={`${landingMutedTextClass} mt-1 text-sm`}>Use this for contact, support, privacy, and account requests.</p>
            </div>
          </div>
          <a
            className="mt-5 inline-flex h-11 items-center justify-center gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] px-5 text-sm font-semibold text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] transition-colors hover:bg-[color:var(--ui-button-primary-hover-bg)]"
            href={`mailto:${siteConfig.supportEmail}`}
          >
            <Mail size={16} />
            {siteConfig.supportEmail}
          </a>
        </div>

        <BugReportForm supportEmail={siteConfig.supportEmail} />
      </div>
    </LegalPage>
  );
}
