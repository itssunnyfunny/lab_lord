import { cn } from "@/lib/utils";
import { AppPanel } from "./AppPanel";
import { PageShell } from "./PageShell";
import {
    pageFilterShellClass,
    pageGridCardClass,
    pageInsetMetricClass,
    pageInsetSurfaceClass,
    pageTableBodyDividerClass,
    pageTableShellClass,
} from "./pageSurface";

export type PageLoadingVariant =
    | "workspace"
    | "dashboard"
    | "table"
    | "analytics"
    | "settings"
    | "ai"
    | "cards";

interface SkeletonBlockProps {
    className?: string;
}

interface PageLoadingSkeletonProps {
    label?: string;
    variant?: PageLoadingVariant;
    rows?: number;
    className?: string;
    maxWidth?: "content" | "wide";
}

export function SkeletonBlock({ className }: SkeletonBlockProps) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                "relative overflow-hidden rounded-[var(--ui-radius-control)] bg-[color:var(--ui-form-muted-surface-bg)] opacity-95 animate-pulse before:absolute before:inset-y-0 before:left-0 before:w-1/2 before:-translate-x-full before:bg-gradient-to-r before:from-transparent before:via-white/[0.07] before:to-transparent before:content-[''] before:animate-shimmer motion-reduce:animate-none motion-reduce:before:animate-none",
                className
            )}
        />
    );
}

function LoadingHeader({ action = true }: { action?: boolean }) {
    return (
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 flex-1 space-y-3">
                <SkeletonBlock className="h-3 w-36" />
                <SkeletonBlock className="h-9 w-full max-w-sm" />
                <SkeletonBlock className="h-4 w-full max-w-2xl" />
            </div>
            {action && (
                <div className="flex gap-2">
                    <SkeletonBlock className="h-10 w-28" />
                    <SkeletonBlock className="h-10 w-36" />
                </div>
            )}
        </header>
    );
}

function LoadingMetrics({ count = 4 }: { count?: number }) {
    return (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: count }, (_, index) => (
                <div key={index} className={cn("space-y-4", pageInsetMetricClass)}>
                    <div className="flex items-start justify-between gap-3">
                        <div className="space-y-2">
                            <SkeletonBlock className="h-3 w-24" />
                            <SkeletonBlock className="h-7 w-28" />
                        </div>
                        <SkeletonBlock className="h-10 w-10" />
                    </div>
                    <SkeletonBlock className="h-2 w-full rounded-full" />
                    <SkeletonBlock className="h-3 w-36" />
                </div>
            ))}
        </section>
    );
}

export function LoadingTableSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
    return (
        <div className={className} aria-hidden="true">
            <div className="grid gap-3 md:hidden">
                {Array.from({ length: Math.min(rows, 4) }, (_, index) => (
                    <div key={index} className={cn("space-y-3", pageGridCardClass)}>
                        <div className="flex items-center gap-3">
                            <SkeletonBlock className="h-10 w-10 rounded-full" />
                            <div className="flex-1 space-y-2">
                                <SkeletonBlock className="h-4 w-36 max-w-full" />
                                <SkeletonBlock className="h-3 w-24" />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <SkeletonBlock className="h-12" />
                            <SkeletonBlock className="h-12" />
                        </div>
                    </div>
                ))}
            </div>
            <div className={cn("hidden md:block", pageTableShellClass)}>
            <div className="grid grid-cols-[minmax(180px,1.5fr)_repeat(3,minmax(96px,0.75fr))_72px] gap-4 border-b border-[color:var(--ui-table-divider)] bg-[color:var(--ui-table-head-bg)] px-4 py-4">
                {Array.from({ length: 5 }, (_, index) => (
                    <SkeletonBlock key={index} className={cn("h-3", index === 0 ? "w-36" : "w-20")} />
                ))}
            </div>
            <div className={pageTableBodyDividerClass}>
                {Array.from({ length: rows }, (_, index) => (
                    <div
                        key={index}
                        className="grid grid-cols-[minmax(180px,1.5fr)_repeat(3,minmax(96px,0.75fr))_72px] items-center gap-4 px-4 py-4"
                    >
                        <div className="flex min-w-0 items-center gap-3">
                            <SkeletonBlock className="h-9 w-9 rounded-full" />
                            <div className="min-w-0 flex-1 space-y-2">
                                <SkeletonBlock className="h-4 w-40 max-w-full" />
                                <SkeletonBlock className="h-3 w-28 max-w-full" />
                            </div>
                        </div>
                        <SkeletonBlock className="h-6 w-20" />
                        <SkeletonBlock className="h-4 w-24" />
                        <SkeletonBlock className="h-4 w-20" />
                        <SkeletonBlock className="h-8 w-8 justify-self-end" />
                    </div>
                ))}
            </div>
            </div>
        </div>
    );
}

export function LoadingCardGrid({ cards = 4, className }: { cards?: number; className?: string }) {
    return (
        <div className={cn("grid grid-cols-1 gap-4 md:grid-cols-2", className)} aria-hidden="true">
            {Array.from({ length: cards }, (_, index) => (
                <div key={index} className={cn("space-y-4", pageGridCardClass)}>
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <SkeletonBlock className="h-11 w-11 rounded-full" />
                            <div className="min-w-0 space-y-2">
                                <SkeletonBlock className="h-4 w-36" />
                                <SkeletonBlock className="h-3 w-24" />
                            </div>
                        </div>
                        <SkeletonBlock className="h-6 w-20 rounded-full" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <SkeletonBlock className="h-16" />
                        <SkeletonBlock className="h-16" />
                    </div>
                    <SkeletonBlock className="h-3 w-3/4" />
                </div>
            ))}
        </div>
    );
}

function LoadingControls() {
    return (
        <div className="flex flex-col gap-3 border-b border-[color:var(--ui-form-section-divider)] pb-4 md:flex-row md:items-center md:justify-between">
            <div className={cn("flex w-full max-w-md items-center gap-2 p-2 md:w-auto", pageFilterShellClass)}>
                <SkeletonBlock className="h-7 w-20" />
                <SkeletonBlock className="h-7 w-20" />
                <SkeletonBlock className="h-7 w-20" />
            </div>
            <SkeletonBlock className="h-9 w-24" />
        </div>
    );
}

function DashboardLoading({ rows }: { rows: number }) {
    return (
        <>
            <LoadingHeader />
            <LoadingMetrics />
            <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.75fr)]">
                <AppPanel contentClassName="space-y-5">
                    <SkeletonBlock className="h-4 w-40" />
                    <SkeletonBlock className="h-56 w-full" />
                </AppPanel>
                <AppPanel contentClassName="space-y-4">
                    {Array.from({ length: Math.min(rows, 5) }, (_, index) => (
                        <div key={index} className="flex items-center gap-3">
                            <SkeletonBlock className="h-9 w-9 rounded-full" />
                            <div className="flex-1 space-y-2">
                                <SkeletonBlock className="h-4 w-32" />
                                <SkeletonBlock className="h-3 w-24" />
                            </div>
                            <SkeletonBlock className="h-6 w-16 rounded-full" />
                        </div>
                    ))}
                </AppPanel>
            </section>
            <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <LoadingTableSkeleton rows={4} />
                <LoadingCardGrid cards={2} className="md:grid-cols-1" />
            </section>
        </>
    );
}

function TableLoading({ rows }: { rows: number }) {
    return (
        <>
            <LoadingHeader />
            <LoadingMetrics count={3} />
            <LoadingControls />
            <LoadingTableSkeleton rows={rows} />
        </>
    );
}

function AnalyticsLoading() {
    return (
        <>
            <LoadingHeader action={false} />
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className={cn("inline-flex w-fit gap-2 p-1", pageFilterShellClass)}>
                    <SkeletonBlock className="h-8 w-24" />
                    <SkeletonBlock className="h-8 w-24" />
                </div>
                <div className="flex flex-wrap gap-2">
                    {Array.from({ length: 5 }, (_, index) => (
                        <SkeletonBlock key={index} className="h-8 w-24" />
                    ))}
                </div>
            </div>
            <LoadingMetrics />
            <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
                <AppPanel className="lg:col-span-2" contentClassName="space-y-5">
                    <SkeletonBlock className="h-4 w-36" />
                    <SkeletonBlock className="h-72 w-full" />
                </AppPanel>
                <AppPanel contentClassName="space-y-4">
                    {Array.from({ length: 4 }, (_, index) => (
                        <div key={index} className={cn("space-y-2 p-3", pageInsetSurfaceClass)}>
                            <SkeletonBlock className="h-3 w-24" />
                            <SkeletonBlock className="h-6 w-20" />
                            <SkeletonBlock className="h-2 w-full rounded-full" />
                        </div>
                    ))}
                </AppPanel>
            </section>
        </>
    );
}

function SettingsLoading() {
    return (
        <>
            <LoadingHeader action={false} />
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                {Array.from({ length: 2 }, (_, panelIndex) => (
                    <AppPanel key={panelIndex} contentClassName="space-y-5">
                        <div className="space-y-2">
                            <SkeletonBlock className="h-4 w-36" />
                            <SkeletonBlock className="h-3 w-52 max-w-full" />
                        </div>
                        {Array.from({ length: panelIndex === 0 ? 4 : 6 }, (_, index) => (
                            <div key={index} className="space-y-2">
                                <SkeletonBlock className="h-3 w-24" />
                                <SkeletonBlock className="h-10 w-full" />
                            </div>
                        ))}
                    </AppPanel>
                ))}
            </div>
        </>
    );
}

function AiLoading() {
    return (
        <>
            <LoadingHeader action={false} />
            <AppPanel contentClassName="space-y-4">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-20 w-full" />
            </AppPanel>
            <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {Array.from({ length: 2 }, (_, panelIndex) => (
                    <AppPanel key={panelIndex} contentClassName="space-y-3">
                        <SkeletonBlock className="h-4 w-32" />
                        {Array.from({ length: 3 }, (_, index) => (
                            <div key={index} className={cn("space-y-3 border-l-4 border-l-[color:var(--ui-form-surface-border)]", pageGridCardClass)}>
                                <div className="flex items-center justify-between gap-3">
                                    <SkeletonBlock className="h-4 w-32" />
                                    <SkeletonBlock className="h-6 w-20 rounded-full" />
                                </div>
                                <SkeletonBlock className="h-3 w-full" />
                                <SkeletonBlock className="h-3 w-4/5" />
                            </div>
                        ))}
                    </AppPanel>
                ))}
            </section>
        </>
    );
}

function WorkspaceLoading() {
    return (
        <>
            <LoadingHeader />
            <LoadingCardGrid cards={4} />
        </>
    );
}

export function EntryLoadingSkeleton({ label = "Loading", cards = 2 }: { label?: string; cards?: number }) {
    return (
        <section role="status" aria-live="polite" className="space-y-5">
            <span className="sr-only">{label}</span>
            <LoadingCardGrid cards={cards} className="md:grid-cols-2" />
        </section>
    );
}

export function PageLoadingSkeleton({
    label = "Loading",
    variant = "table",
    rows = 6,
    className,
    maxWidth = "wide",
}: PageLoadingSkeletonProps) {
    return (
        <PageShell
            role="status"
            aria-live="polite"
            maxWidth={maxWidth}
            className={cn("py-1", className)}
        >
            <span className="sr-only">{label}</span>
            {variant === "workspace" && <WorkspaceLoading />}
            {variant === "dashboard" && <DashboardLoading rows={rows} />}
            {variant === "table" && <TableLoading rows={rows} />}
            {variant === "analytics" && <AnalyticsLoading />}
            {variant === "settings" && <SettingsLoading />}
            {variant === "ai" && <AiLoading />}
            {variant === "cards" && (
                <>
                    <LoadingHeader />
                    <LoadingCardGrid cards={rows} />
                </>
            )}
        </PageShell>
    );
}
