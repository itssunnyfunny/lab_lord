"use client";

import { KpiRow } from "@/components/snapshot/KpiRow";
import { MainChart } from "@/components/snapshot/MainChart";
import { SideStats } from "@/components/snapshot/SideStats";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { AppButton, AppPanel, ErrorState, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { cn } from "@/lib/utils";
import { use, useEffect, useState } from "react";
import { AnalyticsPeriod, analytics, BranchSnapshot, TrendData } from "@/lib/api/analytics";
import { branches } from "@/lib/api/branches";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { formWarningBannerClass } from "@/components/ui/formSurface";
import {
    pageFilterShellClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { ResourceState } from "@/types";
import { failResourceRefresh, resourceData, resourceUpdatedAt, startResourceRefresh } from "@/lib/resourceState";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";

type ChartKey = "revenue" | "collected" | "due" | "utilization" | "students";

interface BranchAnalyticsRow {
    id: string;
    branch: string;
    students: number;
    util: number;
    revenue: number;
    collected: number;
    due: number;
}

interface BranchAnalyticsPayload {
    row: BranchAnalyticsRow;
    snapshot: BranchSnapshot;
    trends: TrendData;
    period: AnalyticsPeriod;
    chart: ChartKey;
    from: string;
    to: string;
}

type SummaryTone = "success" | "danger" | "info" | "neutral";

const PERIODS: { key: AnalyticsPeriod; label: string }[] = [
    { key: "month", label: "Monthly" },
    { key: "all", label: "All time" },
];

const CHARTS: { key: ChartKey; label: string; color: string }[] = [
    { key: "revenue", label: "Revenue", color: "#8b5cf6" },
    { key: "collected", label: "Collected", color: "#10b981" },
    { key: "due", label: "Due", color: "#ef4444" },
    { key: "utilization", label: "Utilization", color: "#06b6d4" },
    { key: "students", label: "Students", color: "#6366f1" },
];

function getTrendWindow(period: AnalyticsPeriod, chart: ChartKey) {
    const to = new Date();
    const from = new Date(to);

    if (period === "month" && ["revenue", "collected", "due"].includes(chart)) {
        from.setDate(1);
        from.setHours(0, 0, 0, 0);
        return { from: from.toISOString(), to: to.toISOString() };
    }

    from.setDate(from.getDate() - 30);
    return { from: from.toISOString(), to: to.toISOString() };
}

export default function AnalyticsPage({ params }: { params: Promise<{ branchId: string }> }) {
    const { branchId } = use(params);

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.analytics} feature="BRANCH_ANALYTICS">
            <AnalyticsContent branchId={branchId} />
        </BranchAccessGuard>
    );
}

function AnalyticsContent({ branchId }: { branchId: string }) {
    const [period, setPeriod] = useState<AnalyticsPeriod>("month");
    const [activeChart, setActiveChart] = useState<ChartKey>("revenue");
    const [resource, setResource] = useState<ResourceState<BranchAnalyticsPayload>>({ status: "loading" });
    const [refreshKey, setRefreshKey] = useState(0);
    const { formatDateTime, formatNumber } = useUserPreferences();
    const formatMoney = (value: number) => formatNumber(value, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });
    const formatPercent = (value: number, maximumFractionDigits = 0) => formatNumber(value / 100, {
        style: "percent",
        maximumFractionDigits,
    });

    useEffect(() => {
        let active = true;
        const loadAnalytics = async () => {
            setResource(current => startResourceRefresh(current));
            try {
                const { from, to } = getTrendWindow(period, activeChart);
                const trendType = activeChart === "utilization" ? "seat" : activeChart === "students" ? "students" : "payment";

                const [branchDetails, snap, trendData] = await Promise.all([
                    branches.getDetails(branchId),
                    analytics.getSnapshot(branchId, { period }),
                    activeChart === "students"
                        ? Promise.resolve([])
                        : analytics.getTrends(branchId, { from, to, type: trendType, period }),
                ]);

                if (!active) return;
                setResource({
                    status: "success",
                    updatedAt: new Date().toISOString(),
                    data: {
                        row: {
                            id: branchDetails.id,
                            branch: branchDetails.name,
                            students: snap.totalStudents,
                            util: snap.occupancyRate,
                            revenue: snap.monthlyRevenue,
                            collected: snap.paidAmount,
                            due: snap.dueAmount,
                        },
                        snapshot: snap,
                        trends: trendData,
                        period,
                        chart: activeChart,
                        from,
                        to,
                    },
                });
            } catch (loadError) {
                console.error("Failed to load analytics", loadError);
                if (active) {
                    setResource(current => failResourceRefresh(
                        current,
                        "The requested analytics view could not be refreshed."
                    ));
                }
            }
        };
        void loadAnalytics();
        return () => { active = false; };
    }, [activeChart, branchId, period, refreshKey]);

    const payload = resourceData(resource);
    const displayedPeriod = payload?.period ?? period;
    const displayedChart = payload?.chart ?? activeChart;
    const snapshot = payload?.snapshot;
    const trends = payload?.trends ?? [];
    const updatedAt = resourceUpdatedAt(resource);

    const chartConfig = CHARTS.find(chart => chart.key === displayedChart) ?? CHARTS[0];

    const chartData = (() => {
        if (displayedChart === "students") {
            if (!snapshot) return [];
            return [
                { date: "Active", value: snapshot.activeStudents, category: "Active" },
                { date: "Inactive", value: Math.max(0, snapshot.totalStudents - snapshot.activeStudents), category: "Inactive" },
            ];
        }

        if (displayedChart === "utilization") {
            return trends;
        }

        const category = displayedChart === "revenue"
            ? "Revenue"
            : displayedChart === "collected"
                ? "Collected"
                : "Pending";

        return trends.filter(item => item.category === category);
    })();

    const valueFormatter = displayedChart === "utilization"
        ? (value: number) => formatPercent(value)
        : displayedChart === "students"
            ? (value: number) => formatNumber(value)
            : formatMoney;
    const chartContext = displayedChart === "students"
        ? "Current active and inactive student counts"
        : displayedPeriod === "month" && ["revenue", "collected", "due"].includes(displayedChart)
            ? `${chartConfig.label} trend for the current month`
            : `${chartConfig.label} trend for the last 30 days`;

    if (resource.status === "loading" && !payload) {
        return <PageLoadingSkeleton label="Loading branch analytics" variant="analytics" />;
    }

    if (resource.status === "error") {
        return (
            <ErrorState
                title="Branch analytics unavailable"
                description={resource.message}
                onRetry={resource.retryable ? () => setRefreshKey(key => key + 1) : undefined}
            />
        );
    }

    if (!payload || !snapshot) {
        return <ErrorState title="Branch analytics unavailable" description="No verified analytics snapshot was returned." />;
    }

    return (
        <PageShell>
            <PageHeader
                title="Analytics & Trends"
                subtitle="Branch performance with corrected revenue, collections, dues, and utilization."
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={pageMutedTextClass}>
                    Updated {updatedAt ? formatDateTime(updatedAt) : "recently"}
                </span>
                <AppButton
                    variant="quiet"
                    size="sm"
                    icon={RefreshCw}
                    isLoading={resource.status === "loading"}
                    onClick={() => setRefreshKey(key => key + 1)}
                >
                    Refresh
                </AppButton>
            </div>

            {(resource.status === "stale" || (resource.status === "loading" && resource.previous)) && (
                <div role="status" className={cn("flex items-start gap-2 px-4 py-3 text-sm", formWarningBannerClass)}>
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    {resource.status === "stale"
                        ? `${resource.reason} Showing ${CHARTS.find(item => item.key === displayedChart)?.label ?? displayedChart} / ${PERIODS.find(item => item.key === displayedPeriod)?.label ?? displayedPeriod} from the last verified response.`
                        : `Loading ${CHARTS.find(item => item.key === activeChart)?.label ?? activeChart} / ${PERIODS.find(item => item.key === period)?.label ?? period}. Showing the previous verified selection until it finishes.`}
                </div>
            )}

            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div role="group" aria-label="Analytics period" className={cn("inline-flex w-fit p-1", pageFilterShellClass)}>
                    {PERIODS.map(item => (
                        <button
                            key={item.key}
                            type="button"
                            aria-pressed={period === item.key}
                            onClick={() => setPeriod(item.key)}
                            className={cn(
                                "rounded-[var(--ui-radius-control)] px-4 py-2 text-sm font-medium transition-colors",
                                period === item.key
                                    ? "bg-[color:var(--ui-form-input-bg)] text-white"
                                    : "text-[color:var(--text-secondary)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-white"
                            )}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                <div role="group" aria-label="Chart metric" className="inline-flex flex-wrap gap-2">
                    {CHARTS.map(item => (
                        <button
                            key={item.key}
                            type="button"
                            aria-pressed={activeChart === item.key}
                            onClick={() => setActiveChart(item.key)}
                            className={cn(
                                "rounded-[var(--ui-radius-control)] border px-3 py-2 text-xs font-semibold transition-colors",
                                activeChart === item.key
                                    ? "border-[color:var(--ui-form-input-focus-border)] bg-[color:var(--ui-form-input-bg)] text-white"
                                    : "border-[color:var(--ui-form-surface-border)] text-[color:var(--text-secondary)] hover:border-[color:var(--ui-form-input-border)] hover:text-white"
                            )}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>

            <KpiRow snapshot={snapshot} branchId={branchId} period={displayedPeriod} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <MainChart
                    data={chartData}
                    title={`${chartConfig.label} ${displayedChart === "students" ? "Snapshot" : "Trend"}`}
                    variant={displayedChart === "students" ? "bar" : "area"}
                    color={chartConfig.color}
                    valueFormatter={valueFormatter}
                    emptyLabel="No data available for this selection."
                    contextLabel={chartContext}
                    dataLabel={displayedChart === "students" ? "Student status" : "Date"}
                />
                <SideStats snapshot={snapshot} period={displayedPeriod} />
            </div>

            <AppPanel
                title="Branch Summary"
                description="A compact snapshot of the current branch numbers."
                contentClassName="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
            >
                {[payload.row].map(item => (
                    <BranchSummaryCard key={`${item.id}-students`} label="Students" value={formatNumber(item.students)} detail={item.branch} tone="info" />
                ))}
                {[payload.row].map(item => (
                    <BranchSummaryCard key={`${item.id}-util`} label="Seat utilization" value={formatPercent(item.util, 2)} detail="Current occupancy" tone="neutral" badge={formatPercent(item.util, 2)} />
                ))}
                {[payload.row].map(item => (
                    <BranchSummaryCard key={`${item.id}-revenue`} label="Revenue" value={formatMoney(item.revenue)} detail={displayedPeriod === "month" ? "This month" : "All time"} tone="neutral" />
                ))}
                {[payload.row].map(item => (
                    <BranchSummaryCard key={`${item.id}-collected`} label="Collected" value={formatMoney(item.collected)} detail="Received payments" tone="success" />
                ))}
                {[payload.row].map(item => (
                    <BranchSummaryCard key={`${item.id}-due`} label="All due" value={formatMoney(item.due)} detail="Open receivables" tone="danger" />
                ))}
            </AppPanel>

            {snapshot?.seatDetails && (
                <AppPanel
                    title="Shift Breakdown"
                    description="Capacity and utilization by shift."
                    contentClassName="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
                >
                        {snapshot.seatDetails.shifts.map((shift) => (
                            <ShiftBreakdownCard key={shift.shiftId} shift={shift} />
                        ))}
                </AppPanel>
            )}
        </PageShell>
    );
}

function toneValueClass(tone: SummaryTone) {
    if (tone === "success") return "text-[color:var(--ui-tone-success-text)]";
    if (tone === "danger") return "text-[color:var(--ui-tone-danger-text)]";
    if (tone === "info") return "text-[color:var(--ui-tone-info-text)]";
    return "text-[color:var(--text-primary)]";
}

function BranchSummaryCard({
    label,
    value,
    detail,
    tone,
    badge,
}: {
    label: string;
    value: string;
    detail: string;
    tone: SummaryTone;
    badge?: string;
}) {
    return (
        <div className={cn("min-w-0 p-4", pageInsetSurfaceClass)}>
            <div className="flex items-start justify-between gap-3">
                <p className={cn("text-xs font-medium uppercase tracking-wide", pageSubtleTextClass)}>{label}</p>
                {badge && <Badge variant="default" className="shrink-0">{badge}</Badge>}
            </div>
            <p className={cn("mt-3 truncate text-xl font-semibold tracking-tight", toneValueClass(tone))}>{value}</p>
            <p className={cn("mt-1 truncate text-xs", pageMutedTextClass)}>{detail}</p>
        </div>
    );
}

function ShiftBreakdownCard({
    shift,
}: {
    shift: NonNullable<BranchSnapshot["seatDetails"]>["shifts"][number];
}) {
    const { formatNumber } = useUserPreferences();
    const percent = Math.min(Math.max(shift.occupancyPercent, 0), 100);
    const available = Math.max(shift.capacity - shift.used, 0);
    const formattedPercent = formatNumber(shift.occupancyPercent / 100, {
        style: "percent",
        maximumFractionDigits: 0,
    });
    const tone = percent >= 90 ? "danger" : percent >= 70 ? "warning" : "success";
    const barClass = tone === "danger"
        ? "bg-[color:var(--ui-tone-danger-progress)]"
        : tone === "warning"
            ? "bg-[color:var(--ui-tone-warning-progress)]"
            : "bg-[color:var(--ui-tone-success-progress)]";

    return (
        <div className={cn(pageGridCardClass, pageGridCardHoverClass)}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-white">{shift.shiftName}</h3>
                    <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>
                        {formatNumber(available)} available of {formatNumber(shift.capacity)}
                    </p>
                </div>
                <Badge variant={tone === "danger" ? "danger" : tone === "warning" ? "warning" : "success"}>
                    {formattedPercent}
                </Badge>
            </div>

            <div className="mt-5 flex items-end justify-between gap-4">
                <div>
                    <p className="text-2xl font-semibold tracking-tight text-white">
                        {formatNumber(shift.used)}
                        <span className={cn("text-sm font-medium", pageMutedTextClass)}> / {formatNumber(shift.capacity)}</span>
                    </p>
                    <p className={cn("mt-1 text-xs", pageMutedTextClass)}>Seats used</p>
                </div>
                <div className={cn("rounded-[var(--ui-radius-control)] px-2.5 py-1 text-xs", pageInsetSurfaceClass)}>
                    Capacity
                </div>
            </div>

            <div className={cn("mt-4 h-2 overflow-hidden rounded-full border", pageSectionDividerClass)}>
                <div className={cn("h-full rounded-full", barClass)} style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}
