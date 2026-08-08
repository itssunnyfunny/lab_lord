"use client";

import { AppButton, AppPanel } from "@/components/ui";
import {
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { cn } from "@/lib/utils";
import { Activity, ArrowRight, IndianRupee, LayoutGrid, TriangleAlert, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";

export type ActivityItem =
    | { type: "allocation"; seat: string; studentName: string; ts: string }
    | { type: "payment"; amount: number; studentName: string; ts: string }
    | { type: "overdue"; count: number; ts: string }
    | { type: "enrollment"; studentName: string; ts: string };

interface RecentActivityProps {
    items: ActivityItem[];
    branchId: string;
}

function getActivityContent(
    item: ActivityItem,
    formatMoney: (amount: number) => string,
    formatNumber: (value: number) => string,
) {
    switch (item.type) {
        case "allocation":
            return {
                icon: LayoutGrid,
                iconClass: "bg-cyan-400/10 text-cyan-300",
                title: `Seat ${item.seat} allocated`,
                description: `${item.studentName} was assigned to a seat.`,
            };
        case "payment":
            return {
                icon: IndianRupee,
                iconClass: "bg-emerald-400/10 text-emerald-300",
                title: "Payment received",
                description: `${formatMoney(item.amount)} collected from ${item.studentName}.`,
            };
        case "overdue":
            return {
                icon: TriangleAlert,
                iconClass: "bg-rose-400/10 text-rose-300",
                title: "Overdue payments detected",
                description: `${formatNumber(item.count)} student${item.count === 1 ? "" : "s"} need follow-up.`,
            };
        case "enrollment":
            return {
                icon: UserPlus,
                iconClass: "bg-violet-400/10 text-violet-300",
                title: "New student enrolled",
                description: `${item.studentName} joined the branch.`,
            };
    }
}

function EmptyActivity() {
    return (
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
            <div className={cn("flex h-10 w-10 items-center justify-center", pageInsetSurfaceClass)}>
                <Activity size={18} className="text-[color:var(--text-muted)]" />
            </div>
            <div>
                <p className="text-sm font-medium text-[color:var(--text-primary)]">No recent activity</p>
                <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>Student, seat, and payment changes will appear here.</p>
            </div>
        </div>
    );
}

export function RecentActivity({ items, branchId }: RecentActivityProps) {
    const router = useRouter();
    const visibleItems = items.slice(0, 7);
    const { formatDateTime, formatNumber } = useUserPreferences();
    const formatMoney = (amount: number) => formatNumber(amount, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });

    return (
        <AppPanel
            title="Activity stream"
            description="Latest movement across branch operations."
            action={
                <AppButton
                    onClick={() => router.push(`/branch/${branchId}/payments`)}
                    variant="quiet"
                    size="sm"
                    rightIcon={ArrowRight}
                >
                    Audit
                </AppButton>
            }
            contentClassName="p-0"
            className="h-full"
        >
            {visibleItems.length === 0 ? (
                <EmptyActivity />
            ) : (
                <div className={cn("divide-y", pageSectionDividerClass)}>
                    {visibleItems.map((item, index) => {
                        const content = getActivityContent(item, formatMoney, formatNumber);
                        const Icon = content.icon;

                        return (
                            <div key={`${item.type}-${item.ts}-${index}`} className="flex gap-3 px-4 py-3">
                                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] ${content.iconClass}`}>
                                    <Icon size={15} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                                        <p className="text-sm font-medium text-[color:var(--text-primary)]">{content.title}</p>
                                        <time dateTime={item.ts} className={cn("shrink-0 text-xs", pageSubtleTextClass)}>
                                            {formatDateTime(item.ts)}
                                        </time>
                                    </div>
                                    <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>{content.description}</p>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </AppPanel>
    );
}
