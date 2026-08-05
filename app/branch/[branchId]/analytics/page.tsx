"use client";

import { KpiRow } from "@/components/snapshot/KpiRow";
import { MainChart } from "@/components/snapshot/MainChart";
import { SideStats } from "@/components/snapshot/SideStats";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { AppPanel, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { cn } from "@/lib/utils";
import { use, useEffect, useMemo, useState } from "react";
import { AnalyticsPeriod, analytics, BranchSnapshot, TrendData } from "@/lib/api/analytics";
import { branches } from "@/lib/api/branches";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { formErrorBannerClass } from "@/components/ui/formSurface";
import {
    pageFilterShellClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";

type ChartKey = "revenue" | "collected" | "due" | "utilization" | "students";

interface BranchAnalyticsRow {
    id: string;
    branch: string;
    students: number;
    util: string;
    revenue: number;
    collected: number;
    due: number;
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

function money(value: number) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }).format(value);
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
    const [data, setData] = useState<BranchAnalyticsRow[]>([]);
    const [snapshot, setSnapshot] = useState<BranchSnapshot | null>(null);
    const [trends, setTrends] = useState<TrendData>([]);
    const [period, setPeriod] = useState<AnalyticsPeriod>("month");
    const [activeChart, setActiveChart] = useState<ChartKey>("revenue");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const loadAnalytics = async () => {
            setLoading(true);
            setError(null);
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

                setData([{
                    id: branchDetails.id,
                    branch: branchDetails.name,
                    students: snap.totalStudents,
                    util: `${snap.occupancyRate.toFixed(2)}%`,
                    revenue: snap.monthlyRevenue,
                    collected: snap.paidAmount,
                    due: snap.dueAmount,
                }]);
                setSnapshot(snap);
                setTrends(trendData);
            } catch (loadError) {
                console.error("Failed to load analytics", loadError);
                setError("Failed to load analytics.");
            } finally {
                setLoading(false);
            }
        };
        loadAnalytics();
    }, [branchId, period, activeChart]);

    const chartConfig = CHARTS.find(chart => chart.key === activeChart) ?? CHARTS[0];

    const chartData = useMemo(() => {
        if (activeChart === "students") {
            if (!snapshot) return [];
            return [
                { date: "Active", value: snapshot.activeStudents, category: "Active" },
                { date: "Inactive", value: Math.max(0, snapshot.totalStudents - snapshot.activeStudents), category: "Inactive" },
            ];
        }

        if (activeChart === "utilization") {
            return trends;
        }

        const category = activeChart === "revenue"
            ? "Revenue"
            : activeChart === "collected"
                ? "Collected"
                : "Pending";

        return trends.filter(item => item.category === category);
    }, [activeChart, snapshot, trends]);

    const valueFormatter = activeChart === "utilization"
        ? (value: number) => `${value.toFixed(0)}%`
        : activeChart === "students"
            ? (value: number) => value.toLocaleString("en-IN")
            : money;

    if (loading && !snapshot) {
        return <PageLoadingSkeleton label="Loading branch analytics" variant="analytics" />;
    }

    return (
        <div className="p-4 md:p-8">
            <PageShell>
            <PageHeader
                title="Analytics & Trends"
                subtitle="Branch performance with corrected revenue, collections, dues, and utilization."
            />

            {error && (
                <div className={cn("px-4 py-3 text-sm", formErrorBannerClass)}>
                    {error}
                </div>
            )}

            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className={cn("inline-flex w-fit p-1", pageFilterShellClass)}>
                    {PERIODS.map(item => (
                        <button
                            key={item.key}
                            type="button"
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

                <div className="inline-flex flex-wrap gap-2">
                    {CHARTS.map(item => (
                        <button
                            key={item.key}
                            type="button"
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

            <KpiRow snapshot={snapshot ?? undefined} branchId={branchId} period={period} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <MainChart
                    data={chartData}
                    title={`${chartConfig.label} ${activeChart === "students" ? "Snapshot" : "Trend"}`}
                    variant={activeChart === "students" ? "bar" : "area"}
                    color={chartConfig.color}
                    valueFormatter={valueFormatter}
                    emptyLabel="No data available for this selection."
                />
                <SideStats snapshot={snapshot ?? undefined} period={period} />
            </div>

            <AppPanel
                title="Branch Summary"
                description="A compact snapshot of the current branch numbers."
                contentClassName="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
            >
                {data.map(item => (
                    <BranchSummaryCard key={`${item.id}-students`} label="Students" value={item.students.toLocaleString("en-IN")} detail={item.branch} tone="info" />
                ))}
                {data.map(item => (
                    <BranchSummaryCard key={`${item.id}-util`} label="Seat utilization" value={item.util} detail="Current occupancy" tone="neutral" badge={item.util} />
                ))}
                {data.map(item => (
                    <BranchSummaryCard key={`${item.id}-revenue`} label="Revenue" value={money(item.revenue)} detail={period === "month" ? "This month" : "All time"} tone="neutral" />
                ))}
                {data.map(item => (
                    <BranchSummaryCard key={`${item.id}-collected`} label="Collected" value={money(item.collected)} detail="Received payments" tone="success" />
                ))}
                {data.map(item => (
                    <BranchSummaryCard key={`${item.id}-due`} label="All due" value={money(item.due)} detail="Open receivables" tone="danger" />
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
        </div>
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
    const percent = Math.min(Math.max(shift.occupancyPercent, 0), 100);
    const available = Math.max(shift.capacity - shift.used, 0);
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
                        {available} available of {shift.capacity}
                    </p>
                </div>
                <Badge variant={tone === "danger" ? "danger" : tone === "warning" ? "warning" : "success"}>
                    {shift.occupancyPercent.toFixed(0)}%
                </Badge>
            </div>

            <div className="mt-5 flex items-end justify-between gap-4">
                <div>
                    <p className="text-2xl font-semibold tracking-tight text-white">
                        {shift.used}
                        <span className={cn("text-sm font-medium", pageMutedTextClass)}> / {shift.capacity}</span>
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
