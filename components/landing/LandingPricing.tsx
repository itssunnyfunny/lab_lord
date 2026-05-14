import { ArrowRight, Check, Sparkles } from "lucide-react";
import {
  landingContainerClass,
  landingDescriptionClass,
  landingEyebrowClass,
  landingMutedTextClass,
  landingPanelClass,
  landingPrimaryButtonClass,
  landingSecondaryButtonClass,
  landingSectionClass,
  landingSubtleTextClass,
  landingTitleClass,
} from "@/components/ui/landingSurface";
import { LandingReveal } from "@/components/landing/LandingReveal";
import { publicBillingPlans, type BillingPlan } from "@/lib/billingPlans";

const plans = publicBillingPlans();

function formatPrice(plan: Pick<BillingPlan, "amount" | "currency" | "custom">) {
  if (plan.amount == null || plan.custom) return "Custom";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: plan.currency,
    maximumFractionDigits: 0,
  }).format(plan.amount);
}

export function LandingPricing({
  onDashboardClick,
}: {
  onDashboardClick: (source: string) => void;
}) {
  return (
    <section id="pricing" className={`${landingSectionClass} overflow-hidden bg-[color:var(--ui-form-muted-surface-bg)]`}>
      <span className="landing-section-glow left-[16%] top-24 h-52 w-52 bg-cyan-400/10 [animation-delay:1.6s]" aria-hidden="true" />
      <div className={`${landingContainerClass} relative`}>
        <div className="mb-10 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(280px,0.5fr)] lg:items-end">
          <LandingReveal variant="left">
            <p className={landingEyebrowClass}>Pricing</p>
            <h2 className={`${landingTitleClass} mt-3`}>Choose your Lab Lords plan.</h2>
            <p className={`${landingDescriptionClass} mt-4 max-w-2xl`}>
              Start with the current monthly plans, then move up when agent control and custom rollout options are ready.
            </p>
          </LandingReveal>

          <LandingReveal variant="right" delay={120} className={`${landingPanelClass} landing-animated-card p-4`}>
            <div className="flex items-center gap-3">
              <div className="landing-live-pulse flex h-10 w-10 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-warning-border)] bg-[color:var(--ui-badge-warning-bg)] text-[color:var(--ui-badge-warning-text)]">
                <Sparkles size={17} />
              </div>
              <div>
                <p className="text-sm font-semibold text-[color:var(--text-primary)]">No lock-in theatre</p>
                <p className={`${landingSubtleTextClass} mt-1 text-xs`}>Current plans start at Rs.399/month while agent control is staged for rollout.</p>
              </div>
            </div>
          </LandingReveal>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan, index) => (
            <LandingReveal
              key={plan.id}
              delay={100 + index * 90}
              variant={plan.featured ? "scale" : "up"}
              className={`${landingPanelClass} flex flex-col p-5 ${
                plan.featured
                  ? "landing-animated-card border-[color:var(--ui-badge-cyan-border)] bg-[rgba(6,182,212,0.1)] shadow-[0_20px_60px_rgba(34,211,238,0.08)]"
                  : "landing-animated-card"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold text-[color:var(--text-primary)]">{plan.shortName}</h3>
                  <p className={`${landingMutedTextClass} mt-2 text-sm leading-6`}>{plan.description}</p>
                </div>
                {plan.featured && (
                  <span className="shrink-0 rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--ui-badge-cyan-text)]">
                    Best fit
                  </span>
                )}
              </div>

              <div className="mt-6">
                <span className="text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">{formatPrice(plan)}</span>
                {!plan.custom && <span className={`${landingSubtleTextClass} ml-2 text-sm`}>/ month</span>}
              </div>

              <button
                type="button"
                onClick={plan.active ? () => onDashboardClick(`landing_pricing_${plan.id.toLowerCase()}`) : undefined}
                disabled={!plan.active}
                className={`${plan.featured ? `${landingPrimaryButtonClass} landing-cta-shine` : landingSecondaryButtonClass} mt-6 w-full disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {plan.active ? `Start ${plan.shortName}` : plan.custom ? "Custom" : "Coming Soon"}
                {plan.active && <ArrowRight size={15} />}
              </button>

              <div className="mt-6 flex-1 space-y-3 border-t border-[color:var(--ui-form-section-divider)] pt-5">
                {plan.features.map(feature => (
                  <div key={feature} className="flex items-center gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] text-[color:var(--ui-badge-success-text)]">
                      <Check size={12} />
                    </span>
                    <span className="text-sm text-[color:var(--text-secondary)]">{feature}</span>
                  </div>
                ))}
              </div>
            </LandingReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
