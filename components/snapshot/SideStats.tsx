"use client";

import { AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { AnalyticsPeriod, BranchSnapshot } from "@/lib/api/analytics";
import { IndianRupee, Wallet } from "lucide-react";

export function SideStats({
    snapshot,
    period = "all",
}: {
    snapshot?: BranchSnapshot;
    period?: AnalyticsPeriod;
}) {
    const { formatNumber } = useUserPreferences();
    const formatMoney = (amount: number) => formatNumber(amount, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });

    if (!snapshot) {
        return (
            <AppPanel className="col-span-1 flex h-[400px] flex-col" title="Revenue Summary" contentClassName="min-h-0 flex-1">
                <div className="flex h-full items-center justify-center text-sm text-[color:var(--text-secondary)]">Loading...</div>
            </AppPanel>
        );
    }

    const periodLabel = period === "month" ? "This month" : "All time";

    return (
        <AppPanel className="col-span-1 flex h-[400px] flex-col" title="Revenue Summary" contentClassName="min-h-0 flex-1">
            <div className="flex h-full flex-col gap-4">
                <div className="relative flex flex-1 flex-col justify-center overflow-hidden rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-4">
                    <div className="absolute right-0 top-0 p-3 opacity-10">
                        <IndianRupee size={80} className="text-[color:var(--ui-badge-cyan-text)]" />
                    </div>
                    <p className="text-sm text-[color:var(--text-secondary)]">Billable Revenue</p>
                    <h3 className="mt-1 text-3xl font-semibold text-[color:var(--text-primary)]">{formatMoney(snapshot.monthlyRevenue)}</h3>
                    <div className="mt-2 flex items-center gap-2">
                        <Badge variant="purple">{periodLabel}</Badge>
                        <span className="text-xs text-[color:var(--text-muted)]">
                            {formatNumber(snapshot.collectionRate / 100, {
                                style: "percent",
                                maximumFractionDigits: 0,
                            })} collected
                        </span>
                    </div>
                </div>

                <div className="relative flex flex-1 flex-col justify-center overflow-hidden rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-4">
                    <div className="absolute right-0 top-0 p-3 opacity-10">
                        <Wallet size={80} className="text-[color:var(--ui-badge-warning-text)]" />
                    </div>
                    <p className="text-sm text-[color:var(--text-secondary)]">All Pending Fees</p>
                    <h3 className="mt-1 text-3xl font-semibold text-[color:var(--text-primary)]">{formatMoney(snapshot.dueAmount)}</h3>
                    <div className="mt-2 flex items-center gap-2">
                        <Badge variant="warning">All due</Badge>
                        <span className="text-xs text-[color:var(--text-muted)]">shown in every period</span>
                    </div>
                </div>
            </div>
        </AppPanel>
    );
}
