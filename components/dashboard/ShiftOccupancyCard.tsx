"use client";

import { AppButton, AppPanel } from "@/components/ui";
import {
    pageInsetSurfaceClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { cn } from "@/lib/utils";
import { ArrowRight, CalendarCheck, CheckCircle2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";

interface Shift {
    shiftId: string;
    shiftName: string;
    used: number;
    capacity: number;
    occupancyPercent: number;
}

interface ShiftOccupancyCardProps {
    shifts: Shift[];
    branchId: string;
}

function getShiftState(percent: number) {
    if (percent >= 100) {
        return {
            label: "Full",
            icon: TriangleAlert,
            text: "text-rose-300",
            bar: "bg-rose-400",
            badge: "border-rose-400/20 bg-rose-400/10 text-rose-200",
        };
    }

    if (percent >= 80) {
        return {
            label: "Tight",
            icon: TriangleAlert,
            text: "text-amber-300",
            bar: "bg-amber-400",
            badge: "border-amber-400/20 bg-amber-400/10 text-amber-200",
        };
    }

    return {
        label: "Healthy",
        icon: CheckCircle2,
        text: "text-emerald-300",
        bar: "bg-emerald-400",
        badge: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
    };
}

export function ShiftOccupancyCard({ shifts, branchId }: ShiftOccupancyCardProps) {
    const router = useRouter();
    const { formatNumber } = useUserPreferences();

    return (
        <AppPanel
            title="Shift occupancy"
            description="Slot usage across configured shift capacity."
            action={
                <AppButton
                    onClick={() => router.push(`/branch/${branchId}/shifts`)}
                    variant="quiet"
                    size="sm"
                    rightIcon={ArrowRight}
                >
                    Manage
                </AppButton>
            }
            contentClassName="p-0"
            className="h-full"
        >
            {shifts.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
                    <div className={cn("flex h-10 w-10 items-center justify-center", pageInsetSurfaceClass)}>
                        <CalendarCheck size={18} className="text-[color:var(--text-muted)]" />
                    </div>
                    <div>
                        <p className="text-sm font-medium text-[color:var(--text-primary)]">No shifts configured</p>
                        <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>Create shifts before tracking seat utilization.</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => router.push(`/branch/${branchId}/shifts`)}
                        className="text-xs font-medium text-[color:var(--ui-form-accent)] transition-colors hover:text-[color:var(--ui-form-accent-hover)]"
                    >
                        Set up shifts
                    </button>
                </div>
            ) : (
                <div className={cn("divide-y", pageSectionDividerClass)}>
                    {shifts.map((shift) => {
                        const percent = Math.max(0, Math.min(shift.occupancyPercent, 100));
                        const state = getShiftState(shift.occupancyPercent);
                        const StateIcon = state.icon;

                        return (
                            <div key={shift.shiftId} className="px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">{shift.shiftName}</p>
                                        <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>
                                            {formatNumber(shift.used)} of {formatNumber(shift.capacity)} slots used
                                        </p>
                                    </div>
                                    <span
                                        className={cn(
                                            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium",
                                            state.badge
                                        )}
                                    >
                                        <StateIcon size={12} />
                                        {state.label}
                                    </span>
                                </div>
                                <div className="mt-3 flex items-center gap-3">
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--ui-form-muted-surface-bg)]">
                                        <div className={cn("h-full rounded-full", state.bar)} style={{ width: `${percent}%` }} />
                                    </div>
                                    <span className={cn("w-11 text-right text-xs font-semibold", state.text)}>
                                        {formatNumber(shift.occupancyPercent / 100, {
                                            style: "percent",
                                            maximumFractionDigits: 0,
                                        })}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </AppPanel>
    );
}
