"use client";

import { AppButton, AppPanel, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { OverdueTable } from "@/components/dashboard/OverdueTable";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { RecentActivity, ActivityItem } from "@/components/dashboard/RecentActivity";
import { RecentStudents } from "@/components/dashboard/RecentStudents";
import { ShiftOccupancyCard } from "@/components/dashboard/ShiftOccupancyCard";
import { StatCard } from "@/components/dashboard/StatCard";
import { useBranchAccess } from "@/hooks/useBranchAccess";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import {
    loadBranchDashboardSources,
    type DashboardOverduePayment,
    type DashboardResourceStatuses,
    type DashboardStudent,
} from "@/lib/branchDashboard";
import type { BranchSnapshot } from "@/lib/api/analytics";
import {
    AlertCircle,
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    IndianRupee,
    LayoutGrid,
    RefreshCw,
    Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useState } from "react";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";

interface DashboardData {
    snapshot: BranchSnapshot | null;
    overduePayments: DashboardOverduePayment[];
    recentStudents: DashboardStudent[];
    activeStudentCount: number;
    activityItems: ActivityItem[];
    branchName: string;
    resources: DashboardResourceStatuses;
    updatedAt: string;
}

function DashboardSkeleton() {
    return <PageLoadingSkeleton label="Loading branch dashboard" variant="dashboard" rows={6} />;
}

function toneForUtilization(rate: number): "success" | "warning" | "danger" {
    if (rate >= 70) return "success";
    if (rate >= 40) return "warning";
    return "danger";
}

function toneForCollection(rate: number, dueAmount: number): "success" | "warning" | "danger" {
    if (dueAmount === 0 || rate >= 85) return "success";
    if (rate >= 60) return "warning";
    return "danger";
}

function DashboardUnavailablePanel({
    title,
    description,
    onRetry,
}: {
    title: string;
    description: string;
    onRetry?: () => void;
}) {
    return (
        <AppPanel title={title} description={description} className="h-full">
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
                <AlertCircle size={22} className="text-amber-300" />
                <p className="max-w-sm text-sm leading-6 text-gray-400">{description}</p>
                {onRetry && (
                    <AppButton onClick={onRetry} variant="secondary" size="sm" icon={RefreshCw}>
                        Try again
                    </AppButton>
                )}
            </div>
        </AppPanel>
    );
}

export default function BranchDashboardPage({
    params,
}: {
    params: Promise<{ branchId: string }>;
}) {
    const { branchId } = use(params);
    const router = useRouter();
    const [data, setData] = useState<DashboardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const { access, loading: accessLoading } = useBranchAccess(branchId);
    const { formatDate, formatDateTime, formatNumber } = useUserPreferences();
    const formatMoney = useMemo(
        () => (value: number) => formatNumber(value, {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 0,
        }),
        [formatNumber]
    );

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            if (accessLoading) return;
            if (!access) {
                setData(null);
                setLoading(false);
                setError("You do not have access to this branch.");
                return;
            }

            if (refreshKey === 0) {
                setLoading(true);
            } else {
                setRefreshing(true);
            }
            setError(null);

            try {
                const sources = await loadBranchDashboardSources(branchId, access.permissions);

                if (cancelled) return;

                const allocations = [...sources.allocations].sort((a, b) => {
                    const left = new Date(a.startDate ?? 0).getTime();
                    const right = new Date(b.startDate ?? 0).getTime();
                    return right - left;
                });
                const paidPayments = [...sources.monthPayments]
                    .filter((payment) => payment.status === "PAID")
                    .sort((a, b) => {
                        const left = new Date(a.paidAt ?? a.updatedAt ?? 0).getTime();
                        const right = new Date(b.paidAt ?? b.updatedAt ?? 0).getTime();
                        return right - left;
                    });
                const overduePayments = sources.overduePayments;
                const sortedStudents = [...sources.students].sort((a, b) => {
                    const left = new Date(a.joinedAt ?? a.createdAt ?? 0).getTime();
                    const right = new Date(b.joinedAt ?? b.createdAt ?? 0).getTime();
                    return right - left;
                });

                const activityItems: ActivityItem[] = [
                    ...allocations.slice(0, 5).map((allocation) => ({
                        type: "allocation" as const,
                        seat: allocation.seat?.label ?? "Seat",
                        studentName: allocation.student?.name ?? "Unknown student",
                        ts: new Date(allocation.startDate ?? new Date()).toISOString(),
                    })),
                    ...paidPayments.slice(0, 5).map((payment) => ({
                        type: "payment" as const,
                        amount: payment.amount,
                        studentName: payment.student?.name ?? "Unknown student",
                        ts: new Date(payment.paidAt ?? payment.updatedAt ?? new Date()).toISOString(),
                    })),
                    ...(overduePayments.length > 0
                        ? [
                            {
                                type: "overdue" as const,
                                count: overduePayments.length,
                                ts: sources.updatedAt,
                            },
                        ]
                        : []),
                    ...sortedStudents.slice(0, 5).map((student) => ({
                        type: "enrollment" as const,
                        studentName: student.name,
                        ts: new Date(student.joinedAt ?? student.createdAt ?? new Date()).toISOString(),
                    })),
                ]
                    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
                    .slice(0, 10);

                setData({
                    snapshot: sources.snapshot,
                    overduePayments,
                    recentStudents: sortedStudents.slice(0, 6),
                    activeStudentCount: sources.students.filter(student => student.status === "ACTIVE").length,
                    activityItems,
                    branchName: access.branchName,
                    resources: sources.resources,
                    updatedAt: sources.updatedAt,
                });

                const failedResources = Object.entries(sources.resources)
                    .filter(([, status]) => status === "error")
                    .map(([resource]) => resource);
                if (failedResources.length > 0) {
                    setError(
                        `${failedResources.join(", ")} data could not be refreshed. Unavailable sections are labelled below.`
                    );
                }
            } catch (loadError) {
                console.error("[Dashboard] load failed", loadError);
                if (!cancelled) {
                    setError("The dashboard could not be refreshed. Previously loaded values may be stale.");
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        };

        load();

        return () => {
            cancelled = true;
        };
    }, [access, accessLoading, branchId, refreshKey]);

    const snap = data?.snapshot ?? null;
    const canAddStudents = access?.permissions.students ?? false;
    const canViewPayments = access?.permissions.view_payments ?? false;
    const analyticsStatus = data?.resources.analytics ?? "error";
    const studentsStatus = data?.resources.students ?? "error";
    const overdueStatus = data?.resources.overdue ?? "error";
    const activityHasError = data
        ? [
            data.resources.students,
            data.resources.allocations,
            data.resources.payments,
            data.resources.overdue,
        ].some(status => status === "error")
        : true;
    const refreshDashboard = () => setRefreshKey(key => key + 1);

    const collectionSummary = useMemo(() => {
        if (!snap) {
            return {
                billed: 0,
                collected: 0,
                pending: 0,
                progress: 0,
                note: analyticsStatus === "restricted"
                    ? "Analytics access is required for revenue metrics."
                    : "Revenue metrics could not be refreshed.",
            };
        }

        const billed = Math.max(snap.monthlyRevenue, snap.paidAmount + snap.dueAmount);
        const progress = billed > 0 ? (snap.paidAmount / billed) * 100 : 0;
        const pending = Math.max(billed - snap.paidAmount, 0);
        const note = snap.dueAmount === 0
            ? "All billed payments are clear."
            : `${formatMoney(snap.dueAmount)} still needs collection follow-up.`;

        return {
            billed,
            collected: snap.paidAmount,
            pending,
            progress,
            note,
        };
    }, [analyticsStatus, formatMoney, snap]);

    if (loading) return <DashboardSkeleton />;

    return (
        <PageShell>
            {error && (
                <div role="alert" className="flex flex-col gap-3 rounded-[8px] border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                        <AlertCircle size={16} className="mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                    {access && (
                        <AppButton
                            onClick={refreshDashboard}
                            variant="secondary"
                            size="sm"
                            icon={RefreshCw}
                            isLoading={refreshing}
                        >
                            Retry
                        </AppButton>
                    )}
                </div>
            )}

            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                        <span>Branch overview</span>
                        <span className="h-1 w-1 rounded-full bg-gray-600" />
                        <span>{formatDate(new Date())}</span>
                        {data?.updatedAt && (
                            <>
                                <span className="h-1 w-1 rounded-full bg-gray-600" />
                                <span>Updated {formatDateTime(data.updatedAt)}</span>
                            </>
                        )}
                    </div>
                    <h1 className="mt-2 truncate text-2xl font-semibold tracking-tight text-white md:text-3xl">
                        {data?.branchName ?? "Dashboard"}
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-400">
                        Monitor collections, occupancy, follow-ups, and student movement from one operating view.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <AppButton
                        onClick={refreshDashboard}
                        variant="quiet"
                        icon={RefreshCw}
                        isLoading={refreshing}
                    >
                        Refresh
                    </AppButton>
                    {canViewPayments && (
                        <AppButton
                            onClick={() => router.push(`/branch/${branchId}/payments`)}
                            variant="secondary"
                            rightIcon={ArrowRight}
                        >
                            Review payments
                        </AppButton>
                    )}
                    {canAddStudents && (
                        <AppButton
                            onClick={() => router.push(`/branch/${branchId}/students`)}
                            variant="primary"
                        >
                            Add student
                        </AppButton>
                    )}
                </div>
            </header>

            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                    title="Collected this month"
                    value={snap ? formatMoney(snap.paidAmount) : analyticsStatus === "restricted" ? "Restricted" : "Unavailable"}
                    sub={snap ? `${formatNumber(snap.collectionRate / 100, { style: "percent", maximumFractionDigits: 0 })} collection rate` : collectionSummary.note}
                    icon={IndianRupee}
                    tone={snap ? toneForCollection(snap.collectionRate, snap.dueAmount) : "neutral"}
                    progress={snap ? collectionSummary.progress : undefined}
                    footer={snap ? `${formatMoney(collectionSummary.pending)} pending` : undefined}
                />
                <StatCard
                    title="Pending dues"
                    value={snap ? formatMoney(snap.dueAmount) : analyticsStatus === "restricted" ? "Restricted" : "Unavailable"}
                    sub={
                        overdueStatus === "success"
                            ? `${formatNumber(data?.overduePayments.length ?? 0)} overdue follow-ups`
                            : overdueStatus === "restricted"
                                ? "Payment access is required"
                                : "Follow-up data unavailable"
                    }
                    icon={AlertTriangle}
                    tone={snap ? (snap.dueAmount > 0 ? "danger" : "success") : "neutral"}
                    alert={!!snap && snap.dueAmount > 0}
                />
                <StatCard
                    title="Active students"
                    value={
                        snap
                            ? formatNumber(snap.activeStudents)
                            : studentsStatus === "success"
                                ? formatNumber(data?.activeStudentCount ?? 0)
                                : studentsStatus === "restricted"
                                    ? "Restricted"
                                    : "Unavailable"
                    }
                    sub={
                        snap
                            ? `${formatNumber(snap.totalStudents)} total profiles`
                            : studentsStatus === "success"
                                ? "Calculated from student records"
                                : studentsStatus === "restricted"
                                    ? "Student access is required"
                                    : "Student records unavailable"
                    }
                    icon={Users}
                    tone="info"
                />
                <StatCard
                    title="Seat utilization"
                    value={snap ? formatNumber(snap.occupancyRate / 100, { style: "percent", maximumFractionDigits: 0 }) : analyticsStatus === "restricted" ? "Restricted" : "Unavailable"}
                    sub={
                        snap?.seatDetails
                            ? `${formatNumber(snap.seatDetails.totalUsedSlots)} of ${formatNumber(snap.seatDetails.totalShiftCapacity)} shift slots`
                            : snap
                                ? `${formatNumber(snap.assignedSeats)} of ${formatNumber(snap.totalSeats)} seats`
                                : analyticsStatus === "restricted"
                                    ? "Analytics access is required"
                                    : "Utilization data unavailable"
                    }
                    icon={LayoutGrid}
                    tone={snap ? toneForUtilization(snap.occupancyRate) : "neutral"}
                    progress={snap ? snap.occupancyRate : undefined}
                />
            </section>

            <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.75fr)]">
                {snap ? (
                    <AppPanel
                        title="Monthly collections"
                        description="Billed, collected, and pending revenue for the active billing month."
                        className="h-full"
                    >
                    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-center">
                        <div>
                            <div className="flex items-end justify-between gap-3">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Collection progress</p>
                                    <p className="mt-2 text-3xl font-semibold tracking-tight text-white">
                                        {snap ? formatNumber(collectionSummary.progress / 100, { style: "percent", maximumFractionDigits: 0 }) : "Restricted"}
                                    </p>
                                </div>
                                {snap && snap.dueAmount === 0 ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-200">
                                        <CheckCircle2 size={13} />
                                        Clear
                                    </span>
                                ) : (
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-200">
                                        <AlertTriangle size={13} />
                                        Follow-up
                                    </span>
                                )}
                            </div>
                            <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/10">
                                <div
                                    className="h-full rounded-full bg-emerald-400"
                                    style={{ width: `${Math.max(0, Math.min(collectionSummary.progress, 100))}%` }}
                                />
                            </div>
                            <p className="mt-3 text-sm leading-6 text-gray-400">{collectionSummary.note}</p>
                        </div>

                        <div className="grid grid-cols-3 gap-3 lg:grid-cols-1">
                            <div className="rounded-[8px] border border-white/10 bg-white/[0.02] p-3">
                                <p className="text-xs text-gray-500">Billed</p>
                                <p className="mt-1 text-sm font-semibold text-white">{formatMoney(collectionSummary.billed)}</p>
                            </div>
                            <div className="rounded-[8px] border border-white/10 bg-white/[0.02] p-3">
                                <p className="text-xs text-gray-500">Collected</p>
                                <p className="mt-1 text-sm font-semibold text-emerald-200">{formatMoney(collectionSummary.collected)}</p>
                            </div>
                            <div className="rounded-[8px] border border-white/10 bg-white/[0.02] p-3">
                                <p className="text-xs text-gray-500">Pending</p>
                                <p className="mt-1 text-sm font-semibold text-amber-200">{formatMoney(collectionSummary.pending)}</p>
                            </div>
                        </div>
                    </div>
                    </AppPanel>
                ) : (
                    <DashboardUnavailablePanel
                        title="Monthly collections"
                        description={
                            analyticsStatus === "restricted"
                                ? "Your role does not include analytics access."
                                : "Collection analytics could not be refreshed."
                        }
                        onRetry={analyticsStatus === "error" ? refreshDashboard : undefined}
                    />
                )}

                <QuickActions branchId={branchId} />
            </section>

            <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
                {overdueStatus === "success" ? (
                    <OverdueTable
                        key={data?.updatedAt ?? "overdue"}
                        payments={data?.overduePayments ?? []}
                        branchId={branchId}
                        recordDecision={getBranchCapabilityDecision(access, "paymentsRecord")}
                    />
                ) : (
                    <DashboardUnavailablePanel
                        title="Payment follow-ups"
                        description={
                            overdueStatus === "restricted"
                                ? "Your role does not include payment access."
                                : "Overdue payment data could not be refreshed."
                        }
                        onRetry={overdueStatus === "error" ? refreshDashboard : undefined}
                    />
                )}
                {snap ? (
                    <ShiftOccupancyCard shifts={snap.seatDetails?.shifts ?? []} branchId={branchId} />
                ) : (
                    <DashboardUnavailablePanel
                        title="Shift occupancy"
                        description={
                            analyticsStatus === "restricted"
                                ? "Your role does not include occupancy analytics."
                                : "Occupancy data could not be refreshed."
                        }
                        onRetry={analyticsStatus === "error" ? refreshDashboard : undefined}
                    />
                )}
            </section>

            <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                {(data?.activityItems.length ?? 0) > 0 || !activityHasError ? (
                    <RecentActivity items={data?.activityItems ?? []} branchId={branchId} />
                ) : (
                    <DashboardUnavailablePanel
                        title="Activity stream"
                        description="Recent activity could not be verified because one or more data sources failed."
                        onRetry={refreshDashboard}
                    />
                )}
                {studentsStatus === "success" ? (
                    <RecentStudents students={data?.recentStudents ?? []} branchId={branchId} />
                ) : (
                    <DashboardUnavailablePanel
                        title="New enrollments"
                        description={
                            studentsStatus === "restricted"
                                ? "Your role does not include student access."
                                : "Recent student records could not be refreshed."
                        }
                        onRetry={studentsStatus === "error" ? refreshDashboard : undefined}
                    />
                )}
            </section>
        </PageShell>
    );
}
