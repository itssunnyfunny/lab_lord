import {
  ArrowRight,
  Bell,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  Grid3X3,
  MessageSquareText,
  ShieldCheck,
  TrendingUp,
  Users,
} from "lucide-react";
import { LogoMark } from "@/components/brand/AppLogo";
import {
  landingContainerClass,
  landingDescriptionClass,
  landingEyebrowClass,
  landingMetricClass,
  landingPrimaryButtonClass,
  landingSecondaryButtonClass,
  landingSubtleTextClass,
} from "@/components/ui/landingSurface";

const heroMetrics = [
  {
    label: "Seat utilization",
    value: "85.4%",
    detail: "128 of 150 seats booked",
    tone: "text-[color:var(--ui-tone-info-text)]",
    icon: Grid3X3,
  },
  {
    label: "Fee health",
    value: "Rs.1.42L",
    detail: "Rs.37k in active dues",
    tone: "text-[color:var(--ui-tone-success-text)]",
    icon: CreditCard,
  },
  {
    label: "Follow-up drafts",
    value: "14",
    detail: "Ready for owner review",
    tone: "text-[color:var(--ui-tone-warning-text)]",
    icon: MessageSquareText,
  },
];

const sceneNavItems = [
  { label: "Command", active: true },
  { label: "Students" },
  { label: "Seats" },
  { label: "Payments" },
  { label: "Review queue" },
];

const seatCells = Array.from({ length: 48 }, (_, index) => index);

const feeRows = [
  { name: "Priya Patel", status: "Paid", amount: "Rs.2,500", tone: "text-[color:var(--ui-tone-success-text)]" },
  { name: "Rahul Mehta", status: "Due", amount: "Rs.1,200", tone: "text-[color:var(--ui-tone-danger-text)]" },
  { name: "Sneha Rao", status: "Review", amount: "Rs.1,800", tone: "text-[color:var(--ui-tone-warning-text)]" },
];

const timeline = [
  { time: "08:40", title: "Morning shift opened", detail: "42 students checked in" },
  { time: "09:10", title: "Seat B3 released", detail: "Auto-conflict check passed" },
  { time: "09:25", title: "Due reminder drafted", detail: "Hindi message ready" },
];

const trustItems = [
  { value: "Branch-first", label: "Every record stays scoped to the right location.", delay: "[animation-delay:520ms]" },
  { value: "Shift-safe", label: "Seat conflicts are blocked before they reach staff.", delay: "[animation-delay:620ms]" },
  { value: "Owner control", label: "Messages and insights wait for owner approval.", delay: "[animation-delay:720ms]" },
];

function HeroDashboardScene() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_68%_22%,rgba(6,182,212,0.14),transparent_32%),linear-gradient(90deg,var(--bg-app)_0%,rgba(5,5,8,0.99)_47%,rgba(5,5,8,0.78)_72%,rgba(5,5,8,0.92)_100%)]" />
      <div
        className="landing-dashboard-drift absolute inset-x-[-18%] top-16 hidden h-[660px] max-w-[1500px] opacity-30 md:block lg:left-[50%] lg:right-[-34%] lg:top-14 lg:opacity-[0.62]"
      >
        <div className="relative h-full overflow-hidden rounded-[20px] border border-white/10 bg-[rgba(8,12,18,0.88)] shadow-[0_40px_120px_rgba(0,0,0,0.55)]">
          <div className="landing-scanline absolute inset-y-0 z-20 w-1/3 bg-[linear-gradient(90deg,transparent,rgba(103,232,249,0.12),transparent)]" />
          <div className="flex h-14 items-center justify-between border-b border-white/10 bg-white/[0.035] px-5">
            <div className="flex items-center gap-3">
              <LogoMark className="h-9 w-9" title="" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Lab Lords operations</p>
                <p className="text-sm font-semibold text-[color:var(--text-primary)]">Downtown Branch</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] px-3 py-2 text-xs text-[color:var(--text-secondary)]">
              <Bell size={13} />
              6 actions
            </div>
          </div>

          <div className="grid h-[calc(100%-3.5rem)] grid-cols-[180px_minmax(0,1fr)_290px]">
            <aside className="border-r border-white/10 bg-white/[0.025] p-4">
              <div className="mb-5 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] p-3">
                <p className="text-xs font-semibold text-[color:var(--text-primary)]">May operations</p>
                <p className="mt-1 text-[11px] text-[color:var(--text-muted)]">3 shifts running today</p>
              </div>
              <nav className="space-y-2">
                {sceneNavItems.map(item => (
                  <div
                    key={item.label}
                    className={`rounded-[var(--ui-radius-control)] px-3 py-2 text-xs font-semibold ${
                      item.active
                        ? "border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                        : "text-[color:var(--text-muted)]"
                    }`}
                  >
                    {item.label}
                  </div>
                ))}
              </nav>
            </aside>

            <div className="p-5">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Sample command center</p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">Branch Overview</h2>
                </div>
                <div className="landing-live-pulse flex items-center gap-2 rounded-full border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] px-3 py-1.5 text-xs font-semibold text-[color:var(--ui-badge-success-text)]">
                  <CheckCircle2 size={13} />
                  Sample 9:00 AM shift
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                {heroMetrics.map(metric => {
                  const Icon = metric.icon;
                  return (
                    <div key={metric.label} className={landingMetricClass}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-[11px] font-medium text-[color:var(--text-muted)]">{metric.label}</p>
                        <Icon size={13} className="shrink-0 text-[color:var(--text-muted)]" />
                      </div>
                      <p className={`mt-2 text-xl font-semibold tracking-tight ${metric.tone}`}>{metric.value}</p>
                      <p className="mt-1 truncate text-[11px] text-[color:var(--text-muted)]">{metric.detail}</p>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 grid grid-cols-[minmax(0,1fr)_220px] gap-4">
                <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[color:var(--text-primary)]">Seat map</p>
                      <p className="mt-1 text-xs text-[color:var(--text-muted)]">Conflict-aware across morning, evening, and full-day shifts.</p>
                    </div>
                    <span className="text-xs font-semibold text-[color:var(--ui-tone-info-text)]">22 free</span>
                  </div>
                  <div className="grid grid-cols-8 gap-2">
                    {seatCells.map(index => {
                      const selected = [10, 11, 12, 27].includes(index);
                      const occupied = [1, 4, 6, 9, 15, 18, 21, 24, 30, 37, 42].includes(index);

                      return (
                        <div
                          key={index}
                          className={`aspect-square rounded-[6px] border ${
                            selected
                              ? "landing-seat-breathe border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]"
                              : occupied
                                ? "border-[color:var(--ui-badge-danger-border)] bg-[color:var(--ui-badge-danger-bg)]"
                                : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)]"
                          }`}
                          style={selected ? { animationDelay: `${index * 55}ms` } : undefined}
                        />
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-[color:var(--text-primary)]">Fee queue</p>
                      <CreditCard size={14} className="text-[color:var(--text-muted)]" />
                    </div>
                    <div className="space-y-2">
                      {feeRows.map(row => (
                        <div key={row.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-xs">
                          <span className="truncate text-[color:var(--text-secondary)]">{row.name}</span>
                          <span className={`font-semibold ${row.tone}`}>{row.status}</span>
                          <span className="col-span-2 text-[11px] text-[color:var(--text-muted)]">{row.amount}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-warning-border)] bg-[color:var(--ui-badge-warning-bg)] p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--ui-badge-warning-text)]">Recommended action</p>
                    <p className="mt-2 text-sm font-semibold leading-5 text-[color:var(--text-primary)]">Approve 5 overdue reminders before noon.</p>
                  </div>
                </div>
              </div>
            </div>

            <aside className="border-l border-white/10 bg-white/[0.025] p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-[color:var(--text-primary)]">Today&apos;s pulse</p>
                <TrendingUp size={15} className="text-[color:var(--ui-tone-success-text)]" />
              </div>
              <div className="space-y-4">
                {timeline.map(item => (
                  <div key={item.title} className="relative pl-8">
                    <span className="landing-live-pulse absolute left-0 top-1 flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[9px] font-semibold text-[color:var(--ui-badge-cyan-text)]" />
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">{item.time}</p>
                    <p className="mt-1 text-xs font-semibold text-[color:var(--text-primary)]">{item.title}</p>
                    <p className="mt-1 text-[11px] leading-5 text-[color:var(--text-muted)]">{item.detail}</p>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingHero({
  isSignedIn,
  onWorkspaceClick,
  onTourClick,
}: {
  isSignedIn: boolean;
  onWorkspaceClick: (source: string) => void;
  onTourClick: (source: string) => void;
}) {
  return (
    <section className="relative z-10 overflow-hidden border-b border-[color:var(--ui-panel-header-border)]">
      <HeroDashboardScene />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(5,5,8,0.16) 0%, rgba(5,5,8,0.04) 46%, var(--bg-app) 100%)",
        }}
      />
      <div className="pointer-events-none absolute inset-y-0 left-0 w-[72%] bg-[linear-gradient(90deg,var(--bg-app)_0%,rgba(5,5,8,0.96)_55%,rgba(5,5,8,0.38)_82%,transparent_100%)]" />

      <div className={`${landingContainerClass} relative z-10 flex min-h-[calc(100svh-16rem)] flex-col justify-center py-8 sm:py-10 lg:min-h-[500px] xl:min-h-[500px]`}>
        <div className="max-w-3xl">
          <div className="landing-reveal mb-5 inline-flex items-center gap-2 rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[rgba(6,182,212,0.14)] px-3 py-1.5 text-[color:var(--ui-badge-cyan-text)] shadow-[0_0_34px_rgba(6,182,212,0.12)] backdrop-blur-md">
            <ShieldCheck size={14} />
            <span className={landingEyebrowClass}>Operations software for offline education</span>
          </div>

          <h1 className="landing-reveal max-w-3xl text-4xl font-semibold tracking-tight text-[color:var(--text-primary)] [animation-delay:90ms] [text-shadow:0_16px_50px_rgba(0,0,0,0.95)] sm:text-5xl">
            Management software for study halls, libraries, coaching centres, and tuition businesses.
          </h1>

          <p className={`${landingDescriptionClass} landing-reveal mt-4 max-w-2xl text-base text-slate-300 [animation-delay:270ms] sm:text-lg`}>
            Lab Lords helps offline education businesses manage seats, shifts, students, fees, dues, staff, and branches from one simple dashboard.
          </p>

          <div className="landing-reveal mt-7 flex flex-col gap-3 [animation-delay:380ms] sm:flex-row">
            <button type="button" onClick={() => onWorkspaceClick("landing_hero_primary")} className={`${landingPrimaryButtonClass} landing-cta-shine`}>
              {isSignedIn ? "Open workspace" : "Start with your branch"}
              <ArrowRight size={16} />
            </button>
            <a
              href="#product-tour"
              onClick={() => onTourClick("landing_hero_product_tour")}
              className={landingSecondaryButtonClass}
            >
              <CalendarClock size={16} />
              See product tour
            </a>
          </div>
        </div>

        <div className="mt-6 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-3">
          {trustItems.map(item => (
            <div key={item.value} className={`landing-reveal rounded-[var(--ui-radius-control)] border border-white/10 bg-black/35 px-4 py-3 shadow-[0_14px_34px_rgba(0,0,0,0.22)] backdrop-blur-md ${item.delay}`}>
              <p className="text-sm font-semibold text-[color:var(--text-primary)]">{item.value}</p>
              <p className={`${landingSubtleTextClass} mt-1 text-xs leading-5`}>{item.label}</p>
            </div>
          ))}
        </div>

        <div
          className="landing-reveal mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-[color:var(--text-secondary)] [animation-delay:820ms]"
          aria-label="Sample workspace metrics"
        >
          <span className="inline-flex min-h-7 items-center rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-2.5 text-xs font-semibold text-[color:var(--ui-badge-cyan-text)]">
            Sample workspace data
          </span>
          <span className="inline-flex items-center gap-2">
            <Users size={14} className="text-[color:var(--ui-tone-success-text)]" />
            248 active students
          </span>
          <span className="inline-flex items-center gap-2">
            <Grid3X3 size={14} className="text-[color:var(--ui-tone-info-text)]" />
            150 mapped seats
          </span>
          <span className="inline-flex items-center gap-2">
            <MessageSquareText size={14} className="text-[color:var(--ui-tone-warning-text)]" />
            14 drafts ready for review
          </span>
        </div>
      </div>
    </section>
  );
}
