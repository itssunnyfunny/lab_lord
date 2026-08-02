import { Building2, CheckCircle2, ClipboardList, Import, MessageSquareText, Route, UserPlus } from "lucide-react";
import {
  landingContainerClass,
  landingDescriptionClass,
  landingEyebrowClass,
  landingInsetClass,
  landingMutedTextClass,
  landingPanelClass,
  landingSectionClass,
  landingSubtleTextClass,
  landingTitleClass,
} from "@/components/ui/landingSurface";
import { LandingReveal } from "@/components/landing/LandingReveal";

const steps = [
  {
    step: "01",
    title: "Model the branch",
    description:
      "Create branches, seats, shifts, and staff roles so the software reflects the real floor your team already runs.",
    icon: Building2,
  },
  {
    step: "02",
    title: "Move records in",
    description:
      "Add students with contact, fee, and allocation history so your team can search instead of flipping through notebooks.",
    icon: Import,
  },
  {
    step: "03",
    title: "Run daily operations",
    description:
      "Allocate seats, record payments, watch dues, and review branch activity from one owner-grade control surface.",
    icon: ClipboardList,
  },
  {
    step: "04",
    title: "Approve follow-ups",
    description:
      "Let analytics and AI prepare the next action, then approve the messages and decisions that should actually move.",
    icon: MessageSquareText,
  },
];

const migrationPoints = [
  "Import your existing student records",
  "Configure branches, seats, and shifts",
  "Invite managers with controlled access",
  "Start tracking payments and dues",
];

export function LandingHowItWorks() {
  return (
    <section id="workflow" className={`${landingSectionClass} overflow-hidden`}>
      <span className="landing-section-glow right-[12%] top-24 h-48 w-48 bg-violet-400/10 [animation-delay:0.8s]" aria-hidden="true" />
      <div className={`${landingContainerClass} relative`}>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:gap-12">
          <LandingReveal variant="left">
            <p className={landingEyebrowClass}>Workflow</p>
            <h2 className={`${landingTitleClass} mt-3`}>A calmer rollout for a business that cannot pause operations.</h2>
            <p className={`${landingDescriptionClass} mt-4 max-w-xl`}>
              The product is shaped around migration from paper and spreadsheets, so teams can start with one branch and expand without rebuilding the system.
            </p>

            <div className={`${landingPanelClass} mt-8 p-5`}>
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]">
                  <Route size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Designed for phased adoption</h3>
                  <p className={`${landingSubtleTextClass} mt-1 text-xs`}>Start operational, then layer analytics and AI.</p>
                </div>
              </div>

              <div className="space-y-3">
                {migrationPoints.map(point => (
                  <div key={point} className="flex items-start gap-3 text-sm leading-6 text-[color:var(--text-secondary)]">
                    <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[color:var(--ui-tone-success-text)]" />
                    <span>{point}</span>
                  </div>
                ))}
              </div>
            </div>
          </LandingReveal>

          <LandingReveal variant="right" delay={120} className={`${landingPanelClass} landing-animated-card p-4 sm:p-5`}>
            <div className="space-y-5">
              {steps.map((item, index) => {
                const Icon = item.icon;
                return (
                  <LandingReveal key={item.step} delay={220 + index * 90} variant="right" className="relative grid grid-cols-[auto_minmax(0,1fr)] gap-4">
                    {index !== steps.length - 1 && (
                      <div className="absolute bottom-[-20px] left-5 top-11 w-px bg-[color:var(--ui-form-section-divider)]" />
                    )}
                    <div className={`${landingInsetClass} landing-live-pulse z-10 flex h-10 w-10 shrink-0 items-center justify-center text-[color:var(--ui-form-accent)]`}>
                      <Icon size={17} />
                    </div>
                    <div className="min-w-0 pb-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={landingSubtleTextClass + " text-xs font-semibold"}>{item.step}</span>
                        <h3 className="text-base font-semibold text-[color:var(--text-primary)]">{item.title}</h3>
                      </div>
                      <p className={`${landingMutedTextClass} mt-1 text-sm leading-6`}>{item.description}</p>
                    </div>
                  </LandingReveal>
                );
              })}
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3 border-t border-[color:var(--ui-form-section-divider)] pt-5 sm:grid-cols-2">
              <div className={landingInsetClass + " landing-animated-card p-4"}>
                <UserPlus size={17} className="text-[color:var(--ui-tone-success-text)]" />
                <p className="mt-3 text-sm font-semibold text-[color:var(--text-primary)]">Student records first</p>
                <p className={`${landingSubtleTextClass} mt-1 text-xs leading-5`}>The fastest path to value is knowing every active student and their allocation.</p>
              </div>
              <div className={landingInsetClass + " landing-animated-card p-4"}>
                <ClipboardList size={17} className="text-[color:var(--ui-tone-info-text)]" />
                <p className="mt-3 text-sm font-semibold text-[color:var(--text-primary)]">Controls before automation</p>
                <p className={`${landingSubtleTextClass} mt-1 text-xs leading-5`}>The system earns trust by making manual operations cleaner before adding intelligence.</p>
              </div>
            </div>
          </LandingReveal>
        </div>
      </div>
    </section>
  );
}
