"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Lock, Check, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { SkeletonBlock } from "@/components/ui";
import { formErrorBannerClass } from "@/components/ui/formSurface";
import {
    pickerCheckBoxClass,
    pickerChoiceCardBaseClass,
    pickerChoiceCardDisabledClass,
    pickerChoiceCardIdleClass,
    pickerChoiceCardSelectedClass,
    pickerChoiceCardSelectedWarningClass,
    pickerDividerClass,
    pickerGroupLabelClass,
    pickerHintClass,
    pickerProgressTrackClass,
    pickerSeatAvailableClass,
    pickerSeatButtonBaseClass,
    pickerSeatCurrentClass,
    pickerSeatOccupiedClass,
    pickerSeatSelectedClass,
    pickerSectionLabelClass,
    pickerTooltipClass,
    pickerWarningHintClass,
} from "@/components/ui/pickerSurface";

// ─── Shared Types ─────────────────────────────────────────────────────────────

export interface ShiftCapacity {
    type: "PRIMARY" | "MULTISHIFT";
    shiftId: string;          // For PRIMARY: shift DB id; For MULTISHIFT: multiShift DB id
    multiShiftId?: string;    // Only set for MULTISHIFT
    name: string;
    startTime: string | null;
    endTime: string | null;
    price: number;
    isReserved: boolean;
    totalSeats: number;
    used: number;
    available: number;
    occupancyPercent: number;
    isFull: boolean;
    studentAlreadyAllocated: boolean;
    componentShiftIds?: string[];
    componentShiftNames?: string[];
}

export interface SeatCell {
    seatId: string;
    label: string;
    occupied: boolean;
    occupiedBy: string | null;
}

export interface SeatMapData {
    shiftId: string;
    shiftName: string;
    isReserved: boolean;
    totalSeats: number;
    occupiedCount: number;
    availableCount: number;
    seats: SeatCell[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capacityBarColor(pct: number, isFull: boolean) {
    if (isFull) return "bg-[color:var(--ui-tone-danger-progress)]";
    if (pct >= 70) return "bg-[color:var(--ui-tone-warning-progress)]";
    return "bg-[color:var(--ui-tone-success-progress)]";
}

function capacityTextColor(pct: number, isFull: boolean) {
    if (isFull) return "text-[color:var(--ui-tone-danger-text)]";
    if (pct >= 70) return "text-[color:var(--ui-tone-warning-text)]";
    return "text-[color:var(--ui-tone-success-text)]";
}

function formatTime(t: string | null) {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    const suffix = h < 12 ? "AM" : "PM";
    const hh = h % 12 || 12;
    return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
}

function ShiftPickerSkeleton() {
    return (
        <div role="status" aria-live="polite" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <span className="sr-only">Loading shifts</span>
            {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="space-y-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] p-3.5">
                    <div className="flex items-start justify-between gap-3">
                        <div className="space-y-2">
                            <SkeletonBlock className="h-3 w-20 rounded-full" />
                            <SkeletonBlock className="h-4 w-28" />
                            <SkeletonBlock className="h-3 w-24" />
                        </div>
                        <SkeletonBlock className="h-5 w-16 rounded-full" />
                    </div>
                    <SkeletonBlock className="h-1.5 w-full rounded-full" />
                </div>
            ))}
        </div>
    );
}

function SeatPickerSkeleton() {
    return (
        <div role="status" aria-live="polite" className="grid grid-cols-5 gap-2 sm:grid-cols-6 lg:grid-cols-7">
            <span className="sr-only">Loading seats</span>
            {Array.from({ length: 14 }, (_, index) => (
                <SkeletonBlock key={index} className="aspect-square w-full" />
            ))}
        </div>
    );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface SeatPickerProps {
    branchId: string;
    studentId?: string;
    selectedShiftIds: string[];
    selectedMultiShiftId?: string | null;
    selectedSeatId: string | null;
    onToggleShift: (shift: ShiftCapacity) => void;
    onSelectSeat: (seatId: string | null) => void;
    /** Allocation IDs to exclude from occupancy checks — used for update/change flows */
    excludeAllocationIds?: string[];
    /** Seat ID of the student's current allocation — shown with a special "Current" indicator */
    currentSeatId?: string;
}

export function SeatPicker({
    branchId,
    studentId,
    selectedShiftIds,
    selectedMultiShiftId,
    selectedSeatId,
    onToggleShift,
    onSelectSeat,
    excludeAllocationIds,
    currentSeatId,
}: SeatPickerProps) {
    const [shifts, setShifts] = useState<ShiftCapacity[]>([]);
    const [shiftsLoading, setShiftsLoading] = useState(false);
    const [shiftsError, setShiftsError] = useState<string | null>(null);

    // The seat map is always fetched for the FIRST selected primary shift.
    // For multi-shifts, selectedShiftIds contains the expanded component IDs,
    // so primaryShiftId is the first component shift ID.
    const primaryShiftId = selectedShiftIds[0] ?? null;
    const excludeAllocationIdsKey = excludeAllocationIds?.join(",") ?? "";
    const [seatMap, setSeatMap] = useState<SeatMapData | null>(null);
    const [seatMapLoading, setSeatMapLoading] = useState(false);
    const [seatMapError, setSeatMapError] = useState<string | null>(null);
    const [hoveredSeat, setHoveredSeat] = useState<string | null>(null);

    // 1. Fetch capacity cards (includes multi-shifts)
    useEffect(() => {
        queueMicrotask(() => {
            setShiftsLoading(true);
            setShiftsError(null);
        });
        let url = `/api/branches/${branchId}/shifts/capacity`;
        const capacityParams = new URLSearchParams();
        if (studentId) capacityParams.set("studentId", studentId);
        if (excludeAllocationIdsKey) capacityParams.set("excludeAllocationIds", excludeAllocationIdsKey);
        const capacityQuery = capacityParams.toString();
        if (capacityQuery) url += `?${capacityQuery}`;

        fetch(url)
            .then(r => {
                if (!r.ok) throw new Error("Failed to load shifts");
                return r.json();
            })
            .then(setShifts)
            .catch(e => setShiftsError(e.message))
            .finally(() => setShiftsLoading(false));
    }, [branchId, studentId, excludeAllocationIdsKey]);

    // 2. Fetch seat grid when shift selection changes.
    //
    //    MULTI-SHIFT: selectedMultiShiftId is set (the MultiShift DB id).
    //      → URL: /shifts/{firstComponentId}/seat-map?multiShiftId={msId}
    //      → Server checks ALL component shifts; seat is occupied if taken in ANY of them.
    //
    //    PRIMARY: selectedMultiShiftId is null.
    //      → URL: /shifts/{shiftId}/seat-map
    //      → Server checks single shift (+ time-overlap logic).
    useEffect(() => {
        if (!primaryShiftId) {
            queueMicrotask(() => setSeatMap(null));
            return;
        }
        queueMicrotask(() => {
            setSeatMapLoading(true);
            setSeatMapError(null);
        });

        const seatMapParams = new URLSearchParams();
        if (selectedMultiShiftId) seatMapParams.set("multiShiftId", selectedMultiShiftId);
        if (excludeAllocationIdsKey) seatMapParams.set("excludeAllocationIds", excludeAllocationIdsKey);
        const seatMapQuery = seatMapParams.toString();
        const seatMapUrl = `/api/branches/${branchId}/shifts/${primaryShiftId}/seat-map${seatMapQuery ? `?${seatMapQuery}` : ""}`;

        fetch(seatMapUrl)
            .then(r => {
                if (!r.ok) throw new Error("Failed to load seat map");
                return r.json();
            })
            .then(setSeatMap)
            .catch(e => setSeatMapError(e.message))
            .finally(() => setSeatMapLoading(false));
    }, [branchId, primaryShiftId, selectedMultiShiftId, excludeAllocationIdsKey]);

    useEffect(() => {
        if (!seatMap || !selectedSeatId) return;
        const selectedSeat = seatMap.seats.find(seat => seat.seatId === selectedSeatId);
        if (!selectedSeat || selectedSeat.occupied) {
            onSelectSeat(null);
        }
    }, [onSelectSeat, seatMap, selectedSeatId]);

    const selectedCount = selectedShiftIds.length;

    // Separate primary and multi-shift items
    const primaryShifts = shifts.filter(s => s.type === "PRIMARY");
    const multiShifts = shifts.filter(s => s.type === "MULTISHIFT");

    return (
        <div className="space-y-6">
            {/* Step 1: Shifts */}
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <p className={pickerSectionLabelClass}>
                        Select shift(s)
                    </p>
                    {selectedCount > 0 && (
                        <span className="text-xs font-medium text-[color:var(--ui-badge-cyan-text)]">
                            {selectedCount} shift{selectedCount > 1 ? "s" : ""} selected
                        </span>
                    )}
                </div>

                {shiftsLoading && (
                    <ShiftPickerSkeleton />
                )}

                {shiftsError && (
                    <div className={cn("p-3 text-sm", formErrorBannerClass)}>
                        {shiftsError}
                    </div>
                )}

                {!shiftsLoading && !shiftsError && (
                    <div className="space-y-4">
                        {/* Primary Shifts */}
                        {primaryShifts.length > 0 && (
                            <div className="space-y-2">
                                <p className={pickerGroupLabelClass}>
                                    <span className="inline-block h-2 w-2 rounded-full bg-[color:var(--ui-badge-warning-text)]" />
                                    Primary shifts
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {primaryShifts.map(shift => (
                                        <ShiftCard
                                            key={shift.shiftId}
                                            shift={shift}
                                            isSelected={selectedShiftIds.includes(shift.shiftId)}
                                            onToggle={onToggleShift}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Multi-Shifts */}
                        {multiShifts.length > 0 && (
                            <div className="space-y-2">
                                <p className={pickerGroupLabelClass}>
                                    <span className="inline-block h-2 w-2 rounded-full bg-[color:var(--ui-badge-purple-text)]" />
                                    Multi-shifts
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {multiShifts.map(shift => (
                                        <ShiftCard
                                            key={shift.shiftId}
                                            shift={shift}
                                            isSelected={
                                                // A MULTISHIFT card is selected when its component IDs are in selectedShiftIds
                                                shift.type === "MULTISHIFT"
                                                    ? (shift.componentShiftIds?.length ?? 0) > 0 &&
                                                      shift.componentShiftIds!.every(id => selectedShiftIds.includes(id))
                                                    : selectedShiftIds.includes(shift.shiftId)
                                            }
                                            onToggle={onToggleShift}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Hint: only show the "first shift only" caveat for manual multi-primary selections */}
                {selectedCount > 1 && !selectedMultiShiftId && (
                    <p className={pickerHintClass}>
                        Seat availability is shown for the first selected shift. The same seat will be booked across all selected shifts.
                    </p>
                )}
                {selectedMultiShiftId && (
                    <p className={pickerWarningHintClass}>
                        Showing seats free across <span className="font-medium text-[color:var(--ui-badge-warning-text)]">all component shifts</span>. A seat is available only if it is unoccupied in every shift of this multi-shift.
                    </p>
                )}
            </div>

            {/* Step 2: Seats (only if at least one shift is selected) */}
            {primaryShiftId && (
                <div className={cn("space-y-4 pt-2 ui-dialog-enter", pickerDividerClass)}>
                    <div className="flex items-center justify-between">
                        <p className={pickerSectionLabelClass}>
                            Select a seat
                        </p>
                        {seatMap && (
                            <div className="text-[10px] text-[color:var(--text-muted)]">
                                <span className="font-medium text-[color:var(--ui-tone-success-text)]">{seatMap.availableCount}</span> free
                                <span className="mx-1">/</span><span className="text-[color:var(--ui-tone-danger-text)]">{seatMap.occupiedCount}</span> taken
                            </div>
                        )}
                    </div>

                    {seatMapLoading && (
                        <SeatPickerSkeleton />
                    )}

                    {seatMapError && (
                        <div className={cn("p-3 text-sm", formErrorBannerClass)}>
                            {seatMapError}
                        </div>
                    )}

                    {!seatMapLoading && !seatMapError && seatMap && (
                        <div className="grid grid-cols-5 gap-2 sm:grid-cols-6 lg:grid-cols-7">
                            {seatMap.seats.map(seat => {
                                const isSelected = selectedSeatId === seat.seatId;
                                const isHovered = hoveredSeat === seat.seatId;
                                const isCurrent = currentSeatId === seat.seatId;

                                return (
                                    <div key={seat.seatId} className="relative group">
                                        <button
                                            type="button"
                                            disabled={seat.occupied}
                                            onClick={() => onSelectSeat(isSelected ? null : seat.seatId)}
                                            onMouseEnter={() => setHoveredSeat(seat.seatId)}
                                            onMouseLeave={() => setHoveredSeat(null)}
                                            className={cn(
                                                pickerSeatButtonBaseClass,
                                                seat.occupied
                                                    ? pickerSeatOccupiedClass
                                                    : isSelected
                                                        ? pickerSeatSelectedClass
                                                        : isCurrent
                                                            ? pickerSeatCurrentClass
                                                            : pickerSeatAvailableClass
                                            )}
                                        >
                                            {isSelected
                                                ? <CheckCircle2 size={14} />
                                                : <span className="truncate px-1 leading-none">{seat.label}</span>
                                            }
                                            {isCurrent && !isSelected && (
                                                <span className="text-[8px] font-bold uppercase leading-none tracking-wide">
                                                    current
                                                </span>
                                            )}
                                        </button>

                                        {/* Tooltip */}
                                        {seat.occupied && isHovered && seat.occupiedBy && (
                                            <div className={pickerTooltipClass}>
                                                {seat.occupiedBy}
                                            </div>
                                        )}
                                        {/* Current seat tooltip */}
                                        {isCurrent && !isSelected && isHovered && (
                                            <div className={pickerTooltipClass}>
                                                Currently assigned
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Shift Card ────────────────────────────────────────────────────────────────

function ShiftCard({
    shift,
    isSelected,
    onToggle,
}: {
    shift: ShiftCapacity;
    isSelected: boolean;
    onToggle: (s: ShiftCapacity) => void;
}) {
    const blocked = shift.isFull || shift.studentAlreadyAllocated;
    const pct = shift.occupancyPercent;
    const isMulti = shift.type === "MULTISHIFT";

    return (
        <button
            type="button"
            disabled={blocked}
            className={cn(
                pickerChoiceCardBaseClass,
                blocked
                    ? pickerChoiceCardDisabledClass
                    : isSelected
                        ? isMulti
                            ? pickerChoiceCardSelectedWarningClass
                            : pickerChoiceCardSelectedClass
                        : pickerChoiceCardIdleClass
            )}
            aria-pressed={isSelected}
            onClick={() => !blocked && onToggle(shift)}
        >
            {/* Checkmark */}
            {!blocked && (
                <span className={cn(
                    pickerCheckBoxClass,
                    isSelected
                        ? isMulti
                            ? "border-[color:var(--ui-badge-warning-border)] bg-[color:var(--ui-badge-warning-text)] text-[color:var(--bg-app)]"
                            : "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-text)] text-[color:var(--bg-app)]"
                        : "border-[color:var(--ui-form-input-border)] bg-[color:var(--ui-form-input-bg)]"
                )}>
                    {isSelected && <Check size={10} strokeWidth={3} />}
                </span>
            )}

            {/* Type badge */}
            <div className="mb-1 pr-6">
                <div className="flex items-center gap-1.5 mb-0.5">
                    {isMulti ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--ui-badge-warning-border)] bg-[color:var(--ui-badge-warning-bg)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[color:var(--ui-badge-warning-text)]">
                            <Layers size={8} /> MULTI-SHIFT
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[color:var(--ui-badge-cyan-text)]">
                            PRIMARY
                        </span>
                    )}
                </div>

                <div className="flex items-start justify-between">
                    <div>
                        <p className={cn("text-sm font-medium", isSelected ? undefined : "text-[color:var(--text-primary)]")}>
                            {shift.name}
                        </p>
                        {isMulti && shift.componentShiftNames && (
                            <p className="mt-0.5 text-[11px] text-[color:var(--text-muted)]">
                                {shift.componentShiftNames.join(" + ")}
                            </p>
                        )}
                        {!isMulti && (shift.startTime || shift.endTime) && (
                            <p className="mt-0.5 text-[11px] text-[color:var(--text-muted)]">
                                {formatTime(shift.startTime)} - {formatTime(shift.endTime)}
                            </p>
                        )}
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                        {shift.studentAlreadyAllocated ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-1.5 py-0.5 text-[10px] text-[color:var(--ui-badge-cyan-text)]">
                                <Lock size={10} /> Allocated
                            </span>
                        ) : shift.isFull ? (
                            <span className="text-xs font-medium text-[color:var(--ui-tone-danger-text)]">Full</span>
                        ) : (
                            <span className={cn("text-xs font-medium", capacityTextColor(pct, shift.isFull))}>
                                {shift.available} / {shift.totalSeats} free
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Capacity bar */}
            <div className={pickerProgressTrackClass}>
                <div
                    className={cn("h-full rounded-full transition-all", capacityBarColor(pct, shift.isFull))}
                    style={{ width: `${Math.min(100, pct)}%` }}
                />
            </div>
        </button>
    );
}
