import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  Grid3X3,
  MessageSquareText,
  ShieldCheck,
  Users,
} from "lucide-react";
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

const branchSignals = [
  { label: "Seats booked", value: "128", detail: "22 available", icon: Grid3X3, tone: "text-[color:var(--ui-tone-info-text)]" },
  { label: "Students active", value: "248", detail: "12 joined this week", icon: Users, tone: "text-[color:var(--ui-tone-success-text)]" },
  { label: "Dues at risk", value: "37k", detail: "5 need follow-up", icon: AlertTriangle, tone: "text-[color:var(--ui-tone-warning-text)]" },
];

const commandRows = [
  { title: "Seat B3 allocation", detail: "Priya Sharma, Morning shift", status: "Ready", tone: "text-[color:var(--ui-tone-success-text)]" },
  { title: "June fee reminder", detail: "Rahul Mehta, 9 days overdue", status: "Draft", tone: "text-[color:var(--ui-tone-warning-text)]" },
  { title: "Staff permission change", detail: "Manager can record payments", status: "Review", tone: "text-[color:var(--ui-tone-info-text)]" },
];

const allocationChecks = [
  "Branch-scoped records",
  "Shift overlap validation",
  "Soft-delete history",
  "Human approval for AI",
];

const lanes = [
  { label: "Morning", value: "86%", tone: "bg-[color:var(--ui-tone-info-progress)]" },
  { label: "Afternoon", value: "71%", tone: "bg-[color:var(--ui-tone-success-progress)]" },
  { label: "Evening", value: "93%", tone: "bg-[color:var(--ui-tone-warning-progress)]" },
];

export function LandingMockup() {
  return (
    <section id="platform" className={`${landingSectionClass} overflow-hidden bg-[color:var(--bg-app)] pt-6 sm:pt-8`}>
      <span className="landing-section-glow right-[8%] top-16 h-44 w-44 bg-cyan-400/10" aria-hidden="true" />
      <div className={`${landingContainerClass} relative`}>
        <div className="mb-10 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(280px,0.4fr)] lg:items-end">
          <LandingReveal variant="left" alwaysVisible>
            <p className={landingEyebrowClass}>Sample product tour</p>
            <h2 id="product-tour" className={`${landingTitleClass} mt-3 scroll-mt-24`}>Replace the register, the spreadsheet, and the staff WhatsApp loop.</h2>
            <p className={`${landingDescriptionClass} mt-4 max-w-2xl`}>
              Lab Lords is designed around the actual pressure points of offline education: physical seats, time-bound shifts, monthly collections, branch staff, and owner approvals.
            </p>
            <p className="mt-3 inline-flex rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-3 py-1.5 text-xs font-semibold text-[color:var(--ui-badge-cyan-text)]">
              Illustrative workspace and sample data
            </p>
          </LandingReveal>

          <LandingReveal alwaysVisible variant="right" delay={120} className={`${landingPanelClass} landing-animated-card p-4`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className={landingSubtleTextClass + " text-xs font-semibold uppercase tracking-wide"}>Sample decision time</p>
                <p className="mt-2 text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">9:12 AM</p>
              </div>
              <div className="landing-live-pulse flex h-11 w-11 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] text-[color:var(--ui-badge-success-text)]">
                <CheckCircle2 size={19} />
              </div>
            </div>
            <p className={`${landingMutedTextClass} mt-3 text-sm leading-6`}>
              Owner has today&apos;s branch status before the first queue builds up.
            </p>
          </LandingReveal>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <LandingReveal alwaysVisible variant="scale" className={`${landingPanelClass} landing-animated-card overflow-hidden`}>
            <div className="flex flex-col gap-3 border-b border-[color:var(--ui-panel-header-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Sample owner workspace</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight text-[color:var(--text-primary)]">Downtown Branch</h3>
              </div>
              <div className="flex w-max items-center gap-2 rounded-full border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] px-3 py-1.5 text-xs font-semibold text-[color:var(--ui-badge-success-text)]">
                <ArrowUpRight size={13} />
                Sample trend
              </div>
            </div>

            <div className="p-4 sm:p-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {branchSignals.map(signal => {
                  const Icon = signal.icon;
                  return (
                    <div key={signal.label} className={landingInsetClass + " landing-animated-card p-4"}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium text-[color:var(--text-muted)]">{signal.label}</p>
                          <p className={`mt-2 text-3xl font-semibold tracking-tight ${signal.tone}`}>{signal.value}</p>
                          <p className={`${landingSubtleTextClass} mt-1 text-xs`}>{signal.detail}</p>
                        </div>
                        <Icon size={17} className="shrink-0 text-[color:var(--text-muted)]" />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className={landingInsetClass + " p-4"}>
                  <div className="mb-5 flex items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold text-[color:var(--text-primary)]">Shift utilization</h4>
                      <p className={`${landingSubtleTextClass} mt-1 text-xs`}>Capacity by live schedule, not a flat seat count.</p>
                    </div>
                    <CalendarClock size={16} className="text-[color:var(--text-muted)]" />
                  </div>

                  <div className="space-y-4">
                    {lanes.map(lane => (
                      <div key={lane.label}>
                        <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                          <span className="font-medium text-[color:var(--text-secondary)]">{lane.label}</span>
                          <span className="font-semibold text-[color:var(--text-primary)]">{lane.value}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-[color:var(--ui-stat-track)]">
                          <div className={`landing-progress-grow h-full rounded-full ${lane.tone}`} style={{ width: lane.value }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={landingInsetClass + " p-4"}>
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h4 className="text-sm font-semibold text-[color:var(--text-primary)]">Guardrails</h4>
                    <ShieldCheck size={16} className="text-[color:var(--ui-tone-info-text)]" />
                  </div>
                  <div className="space-y-3">
                    {allocationChecks.map(check => (
                      <div key={check} className="flex items-center gap-3 text-sm text-[color:var(--text-secondary)]">
                        <CheckCircle2 size={15} className="shrink-0 text-[color:var(--ui-tone-success-text)]" />
                        <span>{check}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </LandingReveal>

          <div className="grid grid-cols-1 gap-4">
            <LandingReveal alwaysVisible delay={140} variant="right" className={`${landingPanelClass} landing-animated-card p-4`}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Action queue</p>
                  <h3 className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">Needs owner attention</h3>
                </div>
                <MessageSquareText size={17} className="text-[color:var(--ui-tone-warning-text)]" />
              </div>
              <div className="space-y-3">
                {commandRows.map(row => (
                  <div key={row.title} className="border-t border-[color:var(--ui-form-section-divider)] pt-3 first:border-t-0 first:pt-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[color:var(--text-primary)]">{row.title}</p>
                        <p className={`${landingSubtleTextClass} mt-1 text-xs leading-5`}>{row.detail}</p>
                      </div>
                      <span className={`shrink-0 text-xs font-semibold ${row.tone}`}>{row.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </LandingReveal>

            <LandingReveal alwaysVisible delay={240} variant="right" className={`${landingPanelClass} landing-animated-card p-4`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Collections</p>
                  <p className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">Rs.37k due</p>
                </div>
                <CreditCard size={18} className="text-[color:var(--ui-tone-info-text)]" />
              </div>
              <p className={`${landingMutedTextClass} mt-3 text-sm leading-6`}>
                Dues, waivers, received payments, and AI follow-up drafts are tied to the same student record.
              </p>
            </LandingReveal>
          </div>
        </div>
      </div>
    </section>
  );
}
