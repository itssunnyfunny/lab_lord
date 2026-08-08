"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Building2, CreditCard, LayoutGrid, RefreshCw, Users } from "lucide-react";
import { analytics, type OrganizationAnalyticsSnapshot } from "@/lib/api/analytics";
import { Badge } from "@/components/ui/Badge";
import { AppButton, AppPanel, ErrorState, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { DataTable } from "@/components/tables/DataTable";
import { StatCard } from "@/components/dashboard/StatCard";
import { cn } from "@/lib/utils";
import { formWarningBannerClass } from "@/components/ui/formSurface";
import {
    pageDescriptionClass,
    pageEyebrowClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetMetricClass,
    pageMetaPillClass,
    pageMutedTextClass,
    pageProgressTrackClass,
    pageSectionDescriptionClass,
    pageSectionTitleClass,
    pageSubtleTextClass,
    pageTitleClass,
} from "@/components/ui/pageSurface";
import { useBillingExperience } from "@/components/billing/BillingExperienceProvider";
import { FeatureUpgradeGate } from "@/components/billing/FeatureUpgradeGate";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { hasFeatureEntitlement } from "@/lib/billingPolicy";
import type { ResourceState } from "@/types";
import { failResourceRefresh, resourceData, resourceUpdatedAt, startResourceRefresh } from "@/lib/resourceState";

type BranchAnalyticsRow = {
    id: string;
    branchId: string;
    branchName: string;
    students: string;
    seated: string;
    utilization: number;
    paidAmount: number;
    dueAmount: number;
    overdueCount: number;
};

type NumberFormatter = (value: number, options?: Intl.NumberFormatOptions) => string;

const currencyFormatOptions: Intl.NumberFormatOptions = {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
};

const percentFormatOptions: Intl.NumberFormatOptions = {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
};

function money(value: number, formatNumber: NumberFormatter) {
    return formatNumber(value, currencyFormatOptions);
}

function percent(value: number, formatNumber: NumberFormatter) {
    return formatNumber(value, percentFormatOptions);
}

function utilizationTone(value: number): "success" | "warning" | "danger" {
    if (value >= 0.7) return "success";
    if (value >= 0.4) return "warning";
    return "danger";
}

export default function OrgAnalyticsPage({ params }: { params: Promise<{ orgId: string }> }) {
    const router = useRouter();
    const { orgId } = use(params);
    const { formatDateTime, formatNumber } = useUserPreferences();
    const billingExperience = useBillingExperience();
    const analyticsAvailable = hasFeatureEntitlement(billingExperience?.experience?.entitlements ?? [], "ORG_ANALYTICS");
    const [snapshotState, setSnapshotState] = useState<ResourceState<OrganizationAnalyticsSnapshot>>({ status: "loading" });
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        if (billingExperience?.loading || !billingExperience?.experience || !analyticsAvailable) return;
        let active = true;

        async function loadAnalytics() {
            setSnapshotState(current => startResourceRefresh(current));

            try {
                const data = await analytics.getOrganizationSnapshot(orgId);
                if (active) setSnapshotState({ status: "success", data, updatedAt: new Date().toISOString() });
            } catch (loadError) {
                console.error("Failed to load organization analytics", loadError);
                if (active) {
                    setSnapshotState(current => failResourceRefresh(
                        current,
                        "Organization analytics could not be refreshed."
                    ));
                }
            }
        }

        loadAnalytics();

        return () => {
            active = false;
        };
    }, [analyticsAvailable, billingExperience?.experience, billingExperience?.loading, orgId, refreshKey]);

    const snapshot = resourceData(snapshotState);
    const updatedAt = resourceUpdatedAt(snapshotState);

    const rows = useMemo<BranchAnalyticsRow[]>(() => {
        return snapshot?.branches.map(branch => ({
            id: branch.branchId,
            branchId: branch.branchId,
            branchName: branch.branchName,
            students: `${formatNumber(branch.snapshot.students.status.active)} / ${formatNumber(branch.snapshot.students.status.total)}`,
            seated: `${formatNumber(branch.snapshot.students.seating.seated)} / ${formatNumber(branch.snapshot.students.seating.activeStudents)}`,
            utilization: branch.snapshot.seats.overall.utilizationRatio,
            paidAmount: branch.snapshot.payments.paidAmount,
            dueAmount: branch.snapshot.payments.dueAmount,
            overdueCount: branch.snapshot.payments.overdueCount,
        })) ?? [];
    }, [formatNumber, snapshot]);

    if (billingExperience?.loading || !billingExperience?.experience) {
        return <PageLoadingSkeleton label="Checking analytics access" variant="analytics" />;
    }

    if (!analyticsAvailable) {
        return <FeatureUpgradeGate feature="ORG_ANALYTICS" experience={billingExperience.experience}><span /></FeatureUpgradeGate>;
    }

    if (snapshotState.status === "loading" && !snapshot) {
        return <PageLoadingSkeleton label="Loading organization analytics" variant="analytics" />;
    }

    if (snapshotState.status === "error") {
        return (
            <ErrorState
                title="Organization analytics unavailable"
                description={snapshotState.message}
                onRetry={snapshotState.retryable ? () => setRefreshKey(key => key + 1) : undefined}
            />
        );
    }

    if (!snapshot) {
        return <ErrorState title="Organization analytics unavailable" description="No verified analytics snapshot was returned." />;
    }

    const collectionBase = snapshot.payments.paidAmount + snapshot.payments.dueAmount;
    const collectionRate = collectionBase > 0 ? snapshot.payments.paidAmount / collectionBase : 0;
    const usedSeatSlots = snapshot.seats.usedSlots ?? snapshot.seats.occupiedSeats;
    const totalSeatSlots = snapshot.seats.totalSlots ?? snapshot.seats.totalSeats;
    const branchCount = snapshot.organization.totalBranches;

    return (
        <PageShell>
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <p className={pageEyebrowClass}>Organization analytics</p>
                    <h1 className={cn(pageTitleClass, "mt-2")}>Cross-branch health</h1>
                    <p className={pageDescriptionClass}>
                        Compare locations quickly, then move into the branch that needs work.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span className={pageMetaPillClass}>
                        Updated {snapshot.asOf || updatedAt ? formatDateTime(snapshot.asOf || updatedAt || "") : "just now"}
                    </span>
                    <AppButton
                        variant="quiet"
                        size="sm"
                        icon={RefreshCw}
                        isLoading={snapshotState.status === "loading"}
                        onClick={() => setRefreshKey(key => key + 1)}
                    >
                        Refresh
                    </AppButton>
                </div>
            </header>

            {(snapshotState.status === "stale" || (snapshotState.status === "loading" && snapshotState.previous)) && (
                <div role="status" className={cn(formWarningBannerClass, "flex items-center gap-2 px-4 py-3 text-sm")}>
                    <AlertCircle size={16} className="shrink-0" />
                    {snapshotState.status === "stale"
                        ? `${snapshotState.reason} Showing the last verified snapshot.`
                        : "Refreshing analytics. Showing the last verified snapshot."}
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <StatCard
                    icon={Building2}
                    title="Branches"
                    value={formatNumber(branchCount)}
                    sub="Operating locations"
                    tone="info"
                />
                <StatCard
                    icon={Users}
                    title="Active students"
                    value={formatNumber(snapshot.students.active)}
                    sub={`${formatNumber(snapshot.students.total)} total profiles`}
                    tone="success"
                />
                <StatCard
                    icon={LayoutGrid}
                    title="Slot utilization"
                    value={percent(snapshot.seats.utilizationRatio, formatNumber)}
                    sub={`${formatNumber(usedSeatSlots)} of ${formatNumber(totalSeatSlots)} slots used`}
                    tone={utilizationTone(snapshot.seats.utilizationRatio)}
                    progress={snapshot.seats.utilizationRatio * 100}
                />
                <StatCard
                    icon={CreditCard}
                    title="Collection rate"
                    value={percent(collectionRate, formatNumber)}
                    sub={`${money(snapshot.payments.paidAmount, formatNumber)} collected`}
                    tone={collectionRate >= 0.75 ? "success" : collectionRate >= 0.5 ? "warning" : "danger"}
                    progress={collectionRate * 100}
                />
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
                <AppPanel title="Seat health" description="How tightly the organization is using available slots.">
                    <div className="space-y-4">
                        <div className="flex items-end justify-between gap-4">
                            <div>
                                <p className="text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">
                                    {percent(snapshot.seats.utilizationRatio, formatNumber)}
                                </p>
                                <p className={cn(pageSubtleTextClass, "mt-1 text-sm")}>Overall utilization</p>
                            </div>
                            <Badge variant="cyan">{formatNumber(usedSeatSlots)} used</Badge>
                        </div>
                        <div className={pageProgressTrackClass}>
                            <div
                                className="h-full rounded-full bg-[color:var(--ui-tone-info-progress)]"
                                style={{ width: `${Math.min(snapshot.seats.utilizationRatio * 100, 100)}%` }}
                            />
                        </div>
                    </div>
                </AppPanel>

                <AppPanel title="Student mix" description="Active vs inactive profile balance.">
                    <div className="grid grid-cols-2 gap-3">
                        <CompactStat label="Active" value={snapshot.students.active} tone="success" />
                        <CompactStat label="Inactive" value={snapshot.students.inactive} tone="neutral" />
                    </div>
                </AppPanel>

                <AppPanel title="Payments" description="Open pressure without burying the page in finance detail.">
                    <div className="grid grid-cols-2 gap-3">
                        <CompactStat label="Paid" value={snapshot.payments.paidCount} tone="success" />
                        <CompactStat label="Due" value={snapshot.payments.dueCount} tone="danger" />
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <AmountStat label="Collected" value={money(snapshot.payments.paidAmount, formatNumber)} tone="success" />
                        <AmountStat label="Due" value={money(snapshot.payments.dueAmount, formatNumber)} tone="danger" />
                    </div>
                </AppPanel>
            </div>

            <section className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <h2 className={pageSectionTitleClass}>Branch breakdown</h2>
                        <p className={pageSectionDescriptionClass}>
                            Scan health, then open the branch dashboard for action.
                        </p>
                    </div>
                    <span className={pageMetaPillClass}>{formatNumber(rows.length)} branches</span>
                </div>
                <DataTable
                    caption="Branch analytics"
                    data={rows}
                    emptyMessage="No branches available for analytics."
                    columns={[
                        { header: "Branch", accessor: "branchName", className: "font-medium text-[color:var(--text-primary)]" },
                        { header: "Active / Total", accessor: "students" },
                        { header: "Seated / Active", accessor: "seated" },
                        {
                            header: "Utilization",
                            accessor: (item) => <Badge variant="cyan">{percent(item.utilization, formatNumber)}</Badge>,
                        },
                        {
                            header: "Collected",
                            accessor: (item) => <span className="font-semibold text-[color:var(--ui-tone-success-text)]">{money(item.paidAmount, formatNumber)}</span>,
                        },
                        {
                            header: "Due",
                            accessor: (item) => <span className="font-semibold text-[color:var(--ui-tone-danger-text)]">{money(item.dueAmount, formatNumber)}</span>,
                        },
                        {
                            header: "Overdue",
                            accessor: (item) => item.overdueCount > 0
                                ? <Badge variant="danger">{formatNumber(item.overdueCount)}</Badge>
                                : <Badge variant="success">{formatNumber(0)}</Badge>,
                        },
                    ]}
                    renderGridCard={(item) => (
                        <BranchAnalyticsCard item={item} onOpen={() => router.push(`/branch/${item.branchId}/analytics`)} />
                    )}
                    actions={(item) => (
                        <AppButton
                            variant="secondary"
                            size="sm"
                            onClick={() => router.push(`/branch/${item.branchId}/analytics`)}
                            rightIcon={ArrowRight}
                            className="whitespace-nowrap"
                        >
                            Open
                        </AppButton>
                    )}
                />
            </section>
        </PageShell>
    );
}

function CompactStat({
    label,
    value,
    tone,
}: {
    label: string;
    value: number;
    tone: "success" | "danger" | "neutral";
}) {
    const { formatNumber } = useUserPreferences();
    const toneClass = {
        success: "text-[color:var(--ui-tone-success-text)]",
        danger: "text-[color:var(--ui-tone-danger-text)]",
        neutral: "text-[color:var(--text-secondary)]",
    }[tone];

    return (
        <div className={pageInsetMetricClass}>
            <p className={cn(pageSubtleTextClass, "text-xs")}>{label}</p>
            <p className={cn("mt-1 text-2xl font-semibold", toneClass)}>{formatNumber(value)}</p>
        </div>
    );
}

function AmountStat({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone: "success" | "danger";
}) {
    const toneClass = tone === "success"
        ? "text-[color:var(--ui-tone-success-text)]"
        : "text-[color:var(--ui-tone-danger-text)]";

    return (
        <div className={pageInsetMetricClass}>
            <p className={cn(pageSubtleTextClass, "text-xs")}>{label}</p>
            <p className={cn("mt-1 truncate text-sm font-semibold", toneClass)}>{value}</p>
        </div>
    );
}

function BranchAnalyticsCard({ item, onOpen }: { item: BranchAnalyticsRow; onOpen: () => void }) {
    const { formatNumber } = useUserPreferences();

    return (
        <button
            type="button"
            onClick={onOpen}
            className={cn(
                "group flex min-h-[220px] w-full cursor-pointer flex-col justify-between text-left",
                pageGridCardClass,
                pageGridCardHoverClass
            )}
        >
            <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="truncate text-base font-semibold text-[color:var(--text-primary)]">{item.branchName}</p>
                        <p className={cn(pageSubtleTextClass, "mt-1 text-xs")}>{item.students} students</p>
                    </div>
                    <Badge variant={utilizationTone(item.utilization)}>{percent(item.utilization, formatNumber)}</Badge>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div className={pageInsetMetricClass}>
                        <p className={cn(pageSubtleTextClass, "text-xs")}>Collected</p>
                        <p className="mt-1 truncate text-sm font-semibold text-[color:var(--ui-tone-success-text)]">
                            {money(item.paidAmount, formatNumber)}
                        </p>
                    </div>
                    <div className={pageInsetMetricClass}>
                        <p className={cn(pageSubtleTextClass, "text-xs")}>Due</p>
                        <p className="mt-1 truncate text-sm font-semibold text-[color:var(--ui-tone-danger-text)]">
                            {money(item.dueAmount, formatNumber)}
                        </p>
                    </div>
                </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 border-t border-[color:var(--ui-form-section-divider)] pt-4">
                <span className={cn(pageMutedTextClass, "text-xs")}>
                    {item.overdueCount > 0 ? `${formatNumber(item.overdueCount)} overdue` : "No overdue payments"}
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[color:var(--ui-form-accent)]">
                    Open analytics
                    <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
                </span>
            </div>
        </button>
    );
}
