"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { AppButton } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Layers, Pencil } from "lucide-react";
import type { DataViewMode } from "@/components/tables/DataTable";
import {
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetMetricClass,
    pageMutedTextClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
    pageTableBodyDividerClass,
    pageTableHeadClass,
    pageTableRowClass,
    pageTableShellClass,
} from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";

interface Allocation {
    id: string;
    studentId: string;
    student: { name: string; status: string; monthlyFee?: number | null };
    seat: { id: string; label: string };
    shiftId: string;
    shift: { name: string; isReserved: boolean };
    startDate: string;
    endDate: string | null;
    multiShiftId?: string | null;
    multiShift?: { id: string; name: string } | null;
}

interface AllocationsTableProps {
    allocations: Allocation[];
    viewMode?: DataViewMode;
    onEndAllocation: (allocationIds: string | string[]) => Promise<void>;
    onUpdateAllocation?: (ids: string[], studentId: string, studentName: string, currentSeatId: string, currentFee: number | null, currentShiftIds: string[], currentMultiShiftId: string | null) => void;
    isEndedTab?: boolean;
    highlightedAllocationId?: string;
    showActions?: boolean;
    actionsEnabled?: boolean;
    actionsDisabledReason?: string;
}

interface GroupedAllocation {
    isMulti: boolean;
    id: string; // main key
    ids: string[]; // all ids
    studentId: string;
    student: { name: string; status: string; monthlyFee?: number | null };
    seat: { id: string; label: string };
    startDate: string;
    endDate: string | null;
    shiftName: string; // for primary
    shiftIds: string[]; // for all shifts involved
    multiShiftId?: string | null;
    multiShiftName?: string; // for multi
    componentShiftNames?: string[]; // for multi
}

export function AllocationsTable({
    allocations,
    viewMode = "table",
    onEndAllocation,
    onUpdateAllocation,
    isEndedTab = false,
    highlightedAllocationId,
    showActions = true,
    actionsEnabled = true,
    actionsDisabledReason,
}: AllocationsTableProps) {
    const { formatDate } = useUserPreferences();
    const [endingIds, setEndingIds] = useState<string[] | null>(null);
    const [confirmIds, setConfirmIds] = useState<string[] | null>(null);

    const handleEndClick = (ids: string[]) => {
        if (!actionsEnabled) return;
        setConfirmIds(ids);
    };

    const confirmEnd = async () => {
        if (!confirmIds || confirmIds.length === 0) return;
        setEndingIds(confirmIds);
        try {
            await onEndAllocation(confirmIds);
            setConfirmIds(null);
        } finally {
            setEndingIds(null);
        }
    };

    const grouped = new Map<string, GroupedAllocation>();
    const result: GroupedAllocation[] = [];

    allocations.forEach(alloc => {
        const isActive = !alloc.endDate;
        if (alloc.multiShiftId || alloc.multiShift) {
            const msId = alloc.multiShiftId || alloc.multiShift?.id;
            const msName = alloc.multiShift?.name || "MULTI-SHIFT";
            const key = `${msId}-${alloc.student.name}-${alloc.seat.label}-${isActive}`;
            if (grouped.has(key)) {
                const group = grouped.get(key)!;
                group.ids.push(alloc.id);
                group.shiftIds.push(alloc.shiftId);
                group.componentShiftNames!.push(alloc.shift.name);
            } else {
                const group: GroupedAllocation = {
                    isMulti: true,
                    id: alloc.id,
                    ids: [alloc.id],
                    studentId: alloc.studentId,
                    student: alloc.student,
                    seat: alloc.seat,
                    startDate: alloc.startDate,
                    endDate: alloc.endDate,
                    shiftName: alloc.shift.name,
                    shiftIds: [alloc.shiftId],
                    multiShiftName: msName,
                    multiShiftId: msId,
                    componentShiftNames: [alloc.shift.name],
                };
                grouped.set(key, group);
                result.push(group);
            }
        } else {
            result.push({
                isMulti: false,
                id: alloc.id,
                ids: [alloc.id],
                studentId: alloc.studentId,
                student: alloc.student,
                seat: alloc.seat,
                startDate: alloc.startDate,
                endDate: alloc.endDate,
                shiftName: alloc.shift.name,
                shiftIds: [alloc.shiftId],
            });
        }
    });

    // Sort: Active first, then by date desc
    const sorted = result.sort((a, b) => {
        const aActive = !a.endDate;
        const bActive = !b.endDate;
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
    });

    const renderShiftSummary = (alloc: GroupedAllocation) => {
        if (alloc.isMulti) {
            return (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1 rounded-full border border-orange-500/20 bg-orange-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-orange-300">
                            <Layers size={9} /> MULTI-SHIFT
                        </span>
                        <span className="text-sm font-semibold text-[color:var(--ui-table-text)]">{alloc.multiShiftName}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                        {alloc.componentShiftNames?.map((name, i) => (
                            <span
                                key={i}
                                className="rounded-md border border-[color:var(--ui-table-border)] bg-[color:var(--ui-table-action-bg)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--ui-table-muted)] shadow-sm"
                            >
                                {name}
                            </span>
                        ))}
                    </div>
                </div>
            );
        }

        return (
            <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-yellow-500/20 bg-yellow-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-yellow-300">
                    PRIMARY
                </span>
                <span className="text-sm font-medium text-[color:var(--ui-table-text)]">{alloc.shiftName}</span>
            </div>
        );
    };

    const renderAllocationStatus = (alloc: GroupedAllocation) => (
        !alloc.endDate ? (
            <Badge variant="success">Active</Badge>
        ) : (
            <div className="flex flex-col items-start gap-1">
                <Badge variant="default">Ended</Badge>
                <span className={cn("text-[10px]", pageSubtleTextClass)}>{formatDate(alloc.endDate)}</span>
            </div>
        )
    );

    const renderAllocationActions = (alloc: GroupedAllocation) => {
        if (isEndedTab || alloc.endDate || !showActions) return null;

        return (
            <div className="flex flex-wrap items-center gap-2">
                {onUpdateAllocation && (
                    <AppButton
                        variant="secondary"
                        size="sm"
                        icon={Pencil}
                        disabled={!actionsEnabled}
                        onClick={() => onUpdateAllocation(alloc.ids, alloc.studentId, alloc.student.name, alloc.seat.id, alloc.student.monthlyFee ?? null, alloc.shiftIds, alloc.multiShiftId ?? null)}
                        title={actionsEnabled ? "Change seat / shift" : actionsDisabledReason}
                    >
                        Change
                    </AppButton>
                )}
                <AppButton
                    variant="danger"
                    size="sm"
                    onClick={() => handleEndClick(alloc.ids)}
                    isLoading={endingIds?.some(id => alloc.ids.includes(id))}
                    disabled={!actionsEnabled}
                    title={actionsEnabled ? undefined : actionsDisabledReason}
                >
                    End
                </AppButton>
            </div>
        );
    };

    const allocationCards = (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sorted.map((alloc) => {
                const actions = renderAllocationActions(alloc);

                return (
                    <div
                        key={alloc.id}
                        id={alloc.ids.includes(highlightedAllocationId ?? "") ? `allocation-record-${highlightedAllocationId}-card` : undefined}
                        tabIndex={alloc.ids.includes(highlightedAllocationId ?? "") ? -1 : undefined}
                        aria-current={alloc.ids.includes(highlightedAllocationId ?? "") ? "true" : undefined}
                        className={cn(
                            "relative flex min-h-[228px] flex-col",
                            pageGridCardClass,
                            pageGridCardHoverClass,
                            alloc.ids.includes(highlightedAllocationId ?? "") && "border-cyan-400/50 bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60"
                        )}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <p className="truncate font-medium text-[color:var(--ui-table-text)]">{alloc.student.name}</p>
                                <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>{alloc.isMulti ? "Multi-shift assignment" : "Primary assignment"}</p>
                            </div>
                            <div className="flex-shrink-0">{renderAllocationStatus(alloc)}</div>
                        </div>

                        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                            <div className={pageInsetMetricClass}>
                                <div className={cn("text-xs", pageSubtleTextClass)}>Seat</div>
                                <div className="mt-1 truncate font-semibold text-[color:var(--ui-table-text)]">{alloc.seat.label}</div>
                            </div>
                            <div className={pageInsetMetricClass}>
                                <div className={cn("text-xs", pageSubtleTextClass)}>Started</div>
                                <div className={cn("mt-1 truncate", pageMutedTextClass)}>{formatDate(alloc.startDate)}</div>
                            </div>
                        </div>

                        <div className={cn("mt-3", pageInsetMetricClass)}>
                            <div className={cn("mb-2 text-xs font-medium uppercase tracking-wide", pageSubtleTextClass)}>Shift</div>
                            {renderShiftSummary(alloc)}
                        </div>

                        {actions && (
                            <div className={cn("mt-auto border-t pt-4", pageSectionDividerClass)}>
                                {actions}
                            </div>
                        )}
                    </div>
                );
            })}

            {sorted.length === 0 && (
                <div className="col-span-full rounded-[var(--ui-table-radius)] border border-dashed border-[color:var(--ui-table-empty-border)] py-12 text-center text-[color:var(--ui-table-subtle)]">
                    No allocations found.
                </div>
            )}
        </div>
    );

    const confirmDialog = (
        <ConfirmDialog
            isOpen={!!confirmIds}
            onClose={() => setConfirmIds(null)}
            onConfirm={confirmEnd}
            title="End Seat Allocation"
            description={confirmIds && confirmIds.length > 1 ? "Are you sure you want to end this multi-shift allocation? All attached shifts will be freed." : "Are you sure you want to end this seat allocation? This will free the seat for future use."}
            confirmText="End Allocation"
            variant="danger"
            loading={!!endingIds}
        />
    );

    if (viewMode === "grid") {
        return (
            <>
                {allocationCards}
                {confirmDialog}
            </>
        );
    }

    return (
        <>
            <div className="md:hidden">{allocationCards}</div>
            <div className={cn("hidden md:block", pageTableShellClass)}>
            <div
                className="w-full overflow-x-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
                role="region"
                aria-label="Loaded seat allocations"
                tabIndex={0}
            >
            <table className="w-full min-w-[58rem] text-left text-sm">
                <caption className="sr-only">Loaded seat allocations</caption>
                <thead className={pageTableHeadClass}>
                    <tr className="text-[color:var(--ui-table-muted)]">
                        <th scope="col" className="px-6 py-4 font-medium">Student</th>
                        <th scope="col" className="px-6 py-4 font-medium">Seat</th>
                        <th scope="col" className="px-6 py-4 font-medium">Shift</th>
                        <th scope="col" className="px-6 py-4 font-medium">Start Date</th>
                        <th scope="col" className="px-6 py-4 font-medium">Status</th>
                        {!isEndedTab && showActions && <th scope="col" className="px-6 py-4 font-medium">Actions</th>}
                    </tr>
                </thead>
                <tbody className={pageTableBodyDividerClass}>
                    {sorted.map((alloc) => {
                        const isActive = !alloc.endDate;
                        const isMulti = alloc.isMulti;

                        return (
                            <tr
                                key={alloc.id}
                                id={alloc.ids.includes(highlightedAllocationId ?? "") ? `allocation-record-${highlightedAllocationId}-row` : undefined}
                                tabIndex={alloc.ids.includes(highlightedAllocationId ?? "") ? -1 : undefined}
                                aria-current={alloc.ids.includes(highlightedAllocationId ?? "") ? "true" : undefined}
                                className={cn(
                                    "group",
                                    pageTableRowClass,
                                    alloc.ids.includes(highlightedAllocationId ?? "") && "bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60"
                                )}
                            >
                                <th scope="row" className="px-6 py-4 text-left font-medium text-[color:var(--ui-table-text)]">
                                    {alloc.student.name}
                                </th>
                                <td className="px-6 py-4 text-[color:var(--ui-table-muted)]">
                                    {alloc.seat.label}
                                </td>
                                <td className="px-6 py-4">
                                    {isMulti ? (
                                        <div className="flex flex-col gap-2">
                                            <div className="flex items-center gap-2">
                                                <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 border border-orange-500/20">
                                                    <Layers size={9} /> MULTI-SHIFT
                                                </span>
                                                <span className="text-sm font-semibold text-[color:var(--ui-table-text)]">{alloc.multiShiftName}</span>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                {alloc.componentShiftNames?.map((name, i) => (
                                                    <span 
                                                        key={i} 
                                                        className="rounded-md border border-[color:var(--ui-table-border)] bg-[color:var(--ui-table-action-bg)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--ui-table-muted)] shadow-sm"
                                                    >
                                                        {name}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300 border border-yellow-500/20">
                                                PRIMARY
                                            </span>
                                            <span className="text-sm font-medium text-[color:var(--ui-table-text)]">{alloc.shiftName}</span>
                                        </div>
                                    )}
                                </td>
                                <td className="px-6 py-4 text-[color:var(--ui-table-muted)]">
                                    {formatDate(alloc.startDate)}
                                </td>
                                <td className="px-6 py-4">
                                    {isActive ? (
                                        <Badge variant="success">Active</Badge>
                                    ) : (
                                        <div className="flex flex-col gap-1">
                                            <Badge variant="default">Ended</Badge>
                                            <span className="text-[10px] text-[color:var(--ui-table-subtle)]">{alloc.endDate ? formatDate(alloc.endDate) : ""}</span>
                                        </div>
                                    )}
                                </td>
                                {!isEndedTab && showActions && (
                                    <td className="px-6 py-4">
                                        {isActive && (
                                            <div className="flex items-center gap-2">
                                                {onUpdateAllocation && (
                                                    <AppButton
                                                        variant="secondary"
                                                        size="sm"
                                                        icon={Pencil}
                                                        disabled={!actionsEnabled}
                                                        onClick={() => onUpdateAllocation(alloc.ids, alloc.studentId, alloc.student.name, alloc.seat.id, alloc.student.monthlyFee ?? null, alloc.shiftIds, alloc.multiShiftId ?? null)}
                                                        title={actionsEnabled ? "Change seat / shift" : actionsDisabledReason}
                                                    >
                                                        Change
                                                    </AppButton>
                                                )}
                                                <AppButton
                                                    variant="danger"
                                                    size="sm"
                                                    onClick={() => handleEndClick(alloc.ids)}
                                                    isLoading={endingIds?.some(id => alloc.ids.includes(id))}
                                                    disabled={!actionsEnabled}
                                                    title={actionsEnabled ? undefined : actionsDisabledReason}
                                                >
                                                    End
                                                </AppButton>
                                            </div>
                                        )}
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                    {sorted.length === 0 && (
                        <tr>
                            <td colSpan={isEndedTab || !showActions ? 5 : 6} className="px-6 py-8 text-center text-[color:var(--ui-table-subtle)]">
                                No allocations found.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
            </div>
            </div>
            {confirmDialog}
        </>
    );
}
