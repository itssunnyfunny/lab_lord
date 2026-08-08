"use client";

import { CreateBranchDialog } from "@/components/branch/CreateBranchDialog";
import { StatCard } from "@/components/dashboard/StatCard";
import { AppButton, AppPanel, ErrorState, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { formErrorBannerClass, formWarningBannerClass } from "@/components/ui/formSurface";
import {
    pageDescriptionClass,
    pageEmptyStateClass,
    pageEyebrowClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetMetricClass,
    pageMetaPillClass,
    pageSectionDescriptionClass,
    pageSectionTitleClass,
    pageSubtleTextClass,
    pageTitleClass,
} from "@/components/ui/pageSurface";
import { analytics, OrganizationAnalyticsSnapshot } from "@/lib/api/analytics";
import { BranchWithCounts, organizations } from "@/lib/api/organizations";
import { cn } from "@/lib/utils";
import { failResourceRefresh, resourceData, resourceUpdatedAt, startResourceRefresh } from "@/lib/resourceState";
import type { ResourceState } from "@/types";
import {
    AlertCircle,
    ArrowRight,
    Building2,
    Clock,
    CreditCard,
    LayoutGrid,
    MapPin,
    Plus,
    RefreshCw,
    TriangleAlert,
    Users,
} from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";

function DashboardSkeleton() {
    return <PageLoadingSkeleton label="Loading organization dashboard" variant="workspace" rows={4} />;
}

function utilizationTone(value: number): "success" | "warning" | "danger" {
    if (value >= 70) return "success";
    if (value >= 40) return "warning";
    return "danger";
}

function getBranchStatus(overdueCount: number, utilization: number) {
    if (overdueCount > 0) {
        return {
            label: "Needs follow-up",
            variant: "danger" as const,
        };
    }

    if (utilization >= 90) {
        return {
            label: "Capacity tight",
            variant: "warning" as const,
        };
    }

    return {
        label: "Operational",
        variant: "success" as const,
    };
}

export default function OrgDashboardPage({ params }: { params: Promise<{ orgId: string }> }) {
    const { orgId } = use(params);
    const { formatDateTime, formatNumber } = useUserPreferences();
    const [branchList, setBranchList] = useState<BranchWithCounts[]>([]);
    const [snapshotState, setSnapshotState] = useState<ResourceState<OrganizationAnalyticsSnapshot>>({ status: "loading" });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const hasLoadedRef = useRef(false);

    const formatMoney = (value: number) => formatNumber(value, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });
    const formatPercent = (value: number) => formatNumber(value / 100, {
        style: "percent",
        maximumFractionDigits: 0,
    });

    const loadDashboard = useCallback(async () => {
        setLoading(!hasLoadedRef.current);
        setError(null);
        setSnapshotState(current => startResourceRefresh(current));

        const [branchesResult, snapshotResult] = await Promise.allSettled([
            organizations.getBranches(orgId),
            analytics.getOrganizationSnapshot(orgId),
        ]);

        if (branchesResult.status === "fulfilled") {
            setBranchList(branchesResult.value);
        } else {
            console.error("Failed to fetch organization branches", branchesResult.reason);
            setError("Failed to load organization branches.");
        }

        if (snapshotResult.status === "fulfilled") {
            setSnapshotState({
                status: "success",
                data: snapshotResult.value,
                updatedAt: new Date().toISOString(),
            });
        } else {
            console.error("Failed to fetch organization context", snapshotResult.reason);
            setSnapshotState(current => failResourceRefresh(
                current,
                "Organization analytics are unavailable. Branch records remain accessible.",
            ));
        }

        hasLoadedRef.current = true;
        setLoading(false);
    }, [orgId]);

    useEffect(() => {
        loadDashboard();
    }, [loadDashboard]);

    const handleBranchCreated = () => {
        setCreateDialogOpen(false);
        loadDashboard();
    };

    const snapshot = resourceData(snapshotState) ?? null;
    const snapshotUpdatedAt = resourceUpdatedAt(snapshotState);
    const snapshotRefreshing = snapshotState.status === "loading" && !loading;

    const branchSnapshotById = useMemo(() => {
        return new Map((snapshot?.branches ?? []).map((branch) => [branch.branchId, branch]));
    }, [snapshot]);

    const totals = useMemo(() => {
        const branches = branchList.length;
        const fallbackSeats = branchList.reduce((sum, branch) => sum + branch._count.seats, 0);
        const fallbackShifts = branchList.reduce((sum, branch) => sum + branch._count.shifts, 0);
        const defaultMonthlyBase = branchList.reduce(
            (sum, branch) => sum + (branch.defaultFee ?? 0) * branch._count.students,
            0
        );

        const utilization = snapshot ? snapshot.seats.utilizationRatio * 100 : null;

        return {
            branches,
            students: snapshot?.students.active ?? null,
            seats: snapshot?.seats.totalSlots ?? fallbackSeats,
            usedSeats: snapshot?.seats.usedSlots ?? null,
            shifts: fallbackShifts,
            utilization,
            paidAmount: snapshot?.payments.paidAmount ?? null,
            dueAmount: snapshot?.payments.dueAmount ?? null,
            overdueCount: snapshot?.payments.overdueCount ?? null,
            defaultMonthlyBase,
        };
    }, [branchList, snapshot]);

    const attentionBranches = useMemo(() => {
        return [...(snapshot?.branches ?? [])]
            .filter((branch) => branch.snapshot.payments.overdueCount > 0)
            .sort((a, b) => b.snapshot.payments.overdueCount - a.snapshot.payments.overdueCount)
            .slice(0, 5);
    }, [snapshot]);

    if (loading) return <DashboardSkeleton />;

    if (error && branchList.length === 0) {
        return (
            <PageShell>
                <ErrorState
                    title="Organization branches unavailable"
                    description={error}
                    onRetry={loadDashboard}
                />
            </PageShell>
        );
    }

    return (
        <PageShell>
            {error && (
                <div className={cn(formErrorBannerClass, "flex items-center gap-3 px-4 py-3 text-sm")}>
                    <AlertCircle size={16} className="shrink-0" />
                    {error}
                </div>
            )}

            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <div className={cn(pageEyebrowClass, "flex flex-wrap items-center gap-2")}>
                        <span>Workspace entry</span>
                        <span className="h-1 w-1 rounded-full bg-[color:var(--text-muted)]" />
                        <span>
                            {snapshot
                                ? `Analytics as of ${formatDateTime(snapshot.asOf)}`
                                : "Analytics unavailable"}
                        </span>
                    </div>
                    <h1 className={cn(pageTitleClass, "mt-2")}>
                        Open a branch dashboard
                    </h1>
                    <p className={pageDescriptionClass}>
                        Choose the branch you want to work in. Organization numbers are here only as quick context.
                    </p>
                </div>

                <div className="flex flex-wrap gap-2">
                    <AppButton
                        onClick={loadDashboard}
                        variant="secondary"
                        icon={RefreshCw}
                        disabled={snapshotRefreshing}
                        isLoading={snapshotRefreshing}
                    >
                        Refresh
                    </AppButton>
                    <AppButton
                        onClick={() => setCreateDialogOpen(true)}
                        variant="primary"
                        icon={Plus}
                    >
                        Create branch
                    </AppButton>
                </div>
            </header>

            {snapshotState.status === "stale" ? (
                <div className={cn(formWarningBannerClass, "flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between")} role="status">
                    <span>{snapshotState.reason} Showing analytics from {formatDateTime(snapshotState.updatedAt)}.</span>
                    <AppButton variant="quiet" size="sm" onClick={loadDashboard}>Retry analytics</AppButton>
                </div>
            ) : snapshotState.status === "error" || snapshotState.status === "restricted" ? (
                <div className={cn(formWarningBannerClass, "flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between")} role="status">
                    <span>{snapshotState.status === "error" ? snapshotState.message : snapshotState.reason}</span>
                    <AppButton variant="quiet" size="sm" onClick={loadDashboard}>Retry analytics</AppButton>
                </div>
            ) : snapshotRefreshing && snapshotUpdatedAt ? (
                <div className={cn(formWarningBannerClass, "px-4 py-3 text-sm")} role="status">
                    Refreshing organization analytics. Current values are from {formatDateTime(snapshotUpdatedAt)}.
                </div>
            ) : null}

            <AppPanel
                title="Choose branch"
                description="Select a branch to continue to students, payments, seats, shifts, and follow-ups."
                action={
                    branchList.length > 0 && (
                        <span className={pageMetaPillClass}>
                            {formatNumber(branchList.length)} available
                        </span>
                    )
                }
                contentClassName="p-4"
            >
                {branchList.length === 0 ? (
                    <div className={cn(pageEmptyStateClass, "min-h-[260px] gap-4")}>
                        <div className="flex h-11 w-11 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)]">
                            <Building2 size={21} className="text-[color:var(--text-muted)]" />
                        </div>
                        <div>
                            <p className="text-sm font-medium text-[color:var(--text-primary)]">No branches yet</p>
                            <p className={cn(pageSubtleTextClass, "mt-1 max-w-sm text-xs leading-5")}>
                                Create your first branch to start using the operational dashboard.
                            </p>
                        </div>
                        <AppButton
                            onClick={() => setCreateDialogOpen(true)}
                            variant="primary"
                            size="sm"
                            icon={Plus}
                        >
                            Create branch
                        </AppButton>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        {branchList.map((branch) => {
                            const branchSnapshot = branchSnapshotById.get(branch.id);
                            const activeStudents = branchSnapshot?.snapshot.students.status.active ?? branch._count.students;
                            const utilization = branchSnapshot
                                ? branchSnapshot.snapshot.seats.overall.utilizationRatio * 100
                                : null;
                            const overdueCount = branchSnapshot?.snapshot.payments.overdueCount ?? null;
                            const status = branchSnapshot
                                ? getBranchStatus(overdueCount ?? 0, utilization ?? 0)
                                : null;

                            return (
                                <Link
                                    key={branch.id}
                                    href={`/branch/${branch.id}`}
                                    aria-label={`Open ${branch.name} dashboard`}
                                    className={cn(
                                        "group relative isolate flex min-h-[214px] cursor-pointer overflow-hidden p-0 text-left transition-transform duration-200 hover:-translate-y-0.5",
                                        pageGridCardClass,
                                        pageGridCardHoverClass
                                    )}
                                >
                                    <span className="absolute inset-x-0 top-0 h-1 bg-[color:var(--ui-form-accent)]" />

                                    <div className="flex min-w-0 flex-1 flex-col justify-between p-5">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex min-w-0 items-start gap-3">
                                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] text-sm font-semibold text-[color:var(--ui-form-accent)]">
                                                    {branch.name.slice(0, 1).toUpperCase()}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="truncate text-lg font-semibold text-[color:var(--text-primary)]">{branch.name}</p>
                                                    <p className={cn(pageSubtleTextClass, "mt-1 flex items-center gap-1.5 text-xs")}>
                                                        <MapPin size={12} />
                                                        {branch.city || "City not set"}
                                                    </p>
                                                </div>
                                            </div>
                                            <Badge variant={status?.variant ?? "default"} className="shrink-0">
                                                {status?.label ?? "Metrics unavailable"}
                                            </Badge>
                                        </div>

                                        <div className="mt-5 grid grid-cols-3 divide-x divide-[color:var(--ui-form-section-divider)] overflow-hidden rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)]">
                                            <div className="px-3 py-3">
                                                <p className={cn(pageSubtleTextClass, "text-xs")}>Students</p>
                                                <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">{formatNumber(activeStudents)}</p>
                                            </div>
                                            <div className="px-3 py-3">
                                                <p className={cn(pageSubtleTextClass, "text-xs")}>Utilization</p>
                                                <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">
                                                    {utilization !== null ? formatPercent(utilization) : "Unavailable"}
                                                </p>
                                            </div>
                                            <div className="px-3 py-3">
                                                <p className={cn(pageSubtleTextClass, "text-xs")}>Overdue</p>
                                                <p className={(overdueCount ?? 0) > 0 ? "mt-1 text-lg font-semibold text-[color:var(--ui-tone-danger-text)]" : "mt-1 text-lg font-semibold text-[color:var(--text-primary)]"}>
                                                    {overdueCount === null ? "Unavailable" : formatNumber(overdueCount)}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="mt-5 flex items-center justify-between gap-3">
                                            <span className={cn(pageSubtleTextClass, "text-xs")}>
                                                {branch.defaultFee ? `${formatMoney(branch.defaultFee)} default fee` : "Fee not set"}
                                            </span>
                                            <span className="inline-flex items-center gap-1.5 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] px-3 py-2 text-xs font-semibold text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] transition-colors group-hover:bg-[color:var(--ui-button-primary-hover-bg)]">
                                                Open dashboard
                                                <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
                                            </span>
                                        </div>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}
            </AppPanel>

            <section className="space-y-3">
                <div>
                    <h2 className={pageSectionTitleClass}>Organization snapshot</h2>
                    <p className={pageSectionDescriptionClass}>Secondary context after branch selection.</p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <StatCard
                        title="Branches"
                        value={formatNumber(totals.branches)}
                        sub={`${formatNumber(totals.shifts)} configured shifts`}
                        icon={Building2}
                        tone="info"
                    />
                    <StatCard
                        title="Active students"
                        value={totals.students === null ? "Unavailable" : formatNumber(totals.students)}
                        sub={totals.students === null ? "Analytics could not be loaded" : "Currently active across branches"}
                        icon={Users}
                        tone={totals.students === null ? "neutral" : "success"}
                    />
                    <StatCard
                        title="Slot utilization"
                        value={totals.utilization === null ? "Unavailable" : formatPercent(totals.utilization)}
                        sub={
                            totals.usedSeats !== null
                                ? `${formatNumber(totals.usedSeats)} of ${formatNumber(totals.seats)} slots used`
                                : `${formatNumber(totals.seats)} seats configured`
                        }
                        icon={LayoutGrid}
                        tone={totals.utilization === null ? "neutral" : utilizationTone(totals.utilization)}
                        progress={totals.utilization ?? undefined}
                    />
                    <StatCard
                        title="Payment risk"
                        value={totals.dueAmount === null ? "Unavailable" : formatMoney(totals.dueAmount)}
                        sub={totals.overdueCount === null
                            ? "Payment analytics could not be loaded"
                            : `${formatNumber(totals.overdueCount)} overdue payments`}
                        icon={TriangleAlert}
                        tone={totals.overdueCount === null ? "neutral" : totals.overdueCount > 0 ? "danger" : "success"}
                        alert={totals.overdueCount !== null && totals.overdueCount > 0}
                    />
                </div>
            </section>

            <section className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <AppPanel
                    title="Revenue coverage"
                    description="Default branch fees and actual payment collection signal."
                >
                    <div className="space-y-4">
                        <div>
                            <p className={cn(pageSubtleTextClass, "text-xs")}>Collected</p>
                            <p className="mt-1 text-2xl font-semibold text-[color:var(--text-primary)]">
                                {totals.paidAmount === null ? "Unavailable" : formatMoney(totals.paidAmount)}
                            </p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className={pageInsetMetricClass}>
                                <p className={cn(pageSubtleTextClass, "text-xs")}>Due</p>
                                <p className="mt-1 text-sm font-semibold text-[color:var(--ui-tone-warning-text)]">
                                    {totals.dueAmount === null ? "Unavailable" : formatMoney(totals.dueAmount)}
                                </p>
                            </div>
                            <div className={pageInsetMetricClass}>
                                <p className={cn(pageSubtleTextClass, "text-xs")}>Fee base</p>
                                <p className="mt-1 text-sm font-semibold text-[color:var(--text-secondary)]">{formatMoney(totals.defaultMonthlyBase)}</p>
                            </div>
                        </div>
                    </div>
                </AppPanel>

                <AppPanel
                    title="Attention queue"
                    description="Branches with overdue payment pressure."
                    contentClassName="p-0"
                >
                    {!snapshot ? (
                        <div className="px-4 py-8 text-center" role="status">
                            <AlertCircle size={22} className="mx-auto text-[color:var(--ui-tone-warning-text)]" />
                            <p className="mt-3 text-sm font-medium text-[color:var(--text-primary)]">Payment analytics unavailable</p>
                            <p className={cn(pageSubtleTextClass, "mt-1 text-xs")}>The queue cannot be confirmed until analytics reloads.</p>
                            <AppButton className="mt-3" variant="quiet" size="sm" onClick={loadDashboard}>Retry</AppButton>
                        </div>
                    ) : attentionBranches.length === 0 ? (
                        <div className="px-4 py-8 text-center">
                            <CreditCard size={22} className="mx-auto text-[color:var(--ui-tone-success-text)]" />
                            <p className="mt-3 text-sm font-medium text-[color:var(--text-primary)]">No overdue branch risk</p>
                            <p className={cn(pageSubtleTextClass, "mt-1 text-xs")}>Payment follow-up queue is clear.</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-[color:var(--ui-form-section-divider)]">
                            {attentionBranches.map((branch) => (
                                <Link
                                    key={branch.branchId}
                                    href={`/branch/${branch.branchId}/payments?status=overdue`}
                                    aria-label={`Review overdue payments for ${branch.branchName}`}
                                    className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[color:var(--ui-form-surface-hover-bg)]"
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm font-medium text-[color:var(--text-primary)]">{branch.branchName}</span>
                                        <span className={cn(pageSubtleTextClass, "mt-1 block text-xs")}>
                                            {formatMoney(branch.snapshot.payments.dueAmount)} pending
                                        </span>
                                    </span>
                                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--ui-badge-danger-border)] bg-[color:var(--ui-badge-danger-bg)] px-2 py-1 text-[11px] font-medium text-[color:var(--ui-badge-danger-text)]">
                                        {formatNumber(branch.snapshot.payments.overdueCount)} overdue
                                        <ArrowRight size={12} />
                                    </span>
                                </Link>
                            ))}
                        </div>
                    )}
                </AppPanel>

                <AppPanel title="Setup footprint" contentClassName="p-0">
                    <div className="divide-y divide-[color:var(--ui-form-section-divider)]">
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                                <LayoutGrid size={15} />
                                Seats
                            </span>
                            <span className="text-sm font-medium text-[color:var(--text-primary)]">{formatNumber(branchList.reduce((sum, branch) => sum + branch._count.seats, 0))}</span>
                        </div>
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                                <Clock size={15} />
                                Shifts
                            </span>
                            <span className="text-sm font-medium text-[color:var(--text-primary)]">{formatNumber(totals.shifts)}</span>
                        </div>
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                                <Users size={15} />
                                Student profiles
                            </span>
                            <span className="text-sm font-medium text-[color:var(--text-primary)]">
                                {formatNumber(branchList.reduce((sum, branch) => sum + branch._count.students, 0))}
                            </span>
                        </div>
                    </div>
                </AppPanel>
            </section>

            <CreateBranchDialog
                isOpen={createDialogOpen}
                onClose={() => setCreateDialogOpen(false)}
                organizationId={orgId}
                onSuccess={handleBranchCreated}
            />
        </PageShell>
    );
}
