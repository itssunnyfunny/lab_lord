import Link from "next/link";
import { AppLogo } from "@/components/brand/AppLogo";
import {
  landingContainerClass,
  landingDescriptionClass,
  landingEyebrowClass,
  landingMutedTextClass,
  landingNavLinkClass,
  landingRootClass,
  landingSubtleTextClass,
} from "@/components/ui/landingSurface";
import { siteConfig } from "@/lib/site";

export type LegalSection = {
  title: string;
  body?: string;
  items?: string[];
};

type LegalPageProps = {
  eyebrow: string;
  title: string;
  description: string;
  updatedAt?: string;
  sections: LegalSection[];
  children?: React.ReactNode;
};

export function LegalPage({
  eyebrow,
  title,
  description,
  updatedAt,
  sections,
  children,
}: LegalPageProps) {
  return (
    <main className={landingRootClass}>
      <header className="border-b border-[color:var(--ui-panel-header-border)]">
        <div className={`${landingContainerClass} flex min-h-16 items-center justify-between gap-4 py-3`}>
          <Link href="/" aria-label="Lab Lords home">
            <AppLogo subtitleClassName="hidden sm:block" />
          </Link>
          <nav className="flex items-center gap-5">
            <Link href="/contact" className={landingNavLinkClass}>Contact Us</Link>
            <Link href="/sign-in" className={landingNavLinkClass}>Sign in</Link>
          </nav>
        </div>
      </header>

      <div className={`${landingContainerClass} py-12 sm:py-16`}>
        <div className="max-w-3xl">
          <p className={landingEyebrowClass}>{eyebrow}</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-[color:var(--text-primary)] sm:text-5xl">
            {title}
          </h1>
          <p className={`${landingDescriptionClass} mt-5`}>{description}</p>
          {updatedAt && (
            <p className={`${landingSubtleTextClass} mt-4 text-sm`}>Last updated: {updatedAt}</p>
          )}
        </div>

        <div className="mt-10 max-w-4xl divide-y divide-[color:var(--ui-panel-header-border)]">
          {sections.map(section => (
            <section key={section.title} className="py-8">
              <h2 className="text-xl font-semibold tracking-tight text-[color:var(--text-primary)]">
                {section.title}
              </h2>
              {section.body && (
                <p className={`${landingMutedTextClass} mt-3 text-sm leading-7`}>
                  {section.body}
                </p>
              )}
              {section.items && (
                <ul className="mt-4 list-disc space-y-3 pl-5">
                  {section.items.map(item => (
                    <li key={item} className={`${landingMutedTextClass} text-sm leading-7`}>
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>

        {children && <div className="mt-4 max-w-4xl">{children}</div>}

        <footer className="mt-12 border-t border-[color:var(--ui-panel-header-border)] pt-6 text-sm text-[color:var(--text-muted)]">
          Questions? Contact <a className="text-[color:var(--ui-form-accent)] hover:text-[color:var(--ui-form-accent-hover)]" href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
        </footer>
      </div>
    </main>
  );
}
