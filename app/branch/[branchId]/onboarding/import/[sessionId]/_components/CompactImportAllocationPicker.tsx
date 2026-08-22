"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Layers, Loader2, Lock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { importSessions } from "@/lib/api/importSessions";
import type { ImportAvailabilityPreview, ImportAvailabilityShift } from "@/importing/contracts/import-preview.contract";
import { allocationSelectionFromDraft } from "@/importing/utils/manual-row-draft";
import {
    pickerCheckBoxClass,
    pickerChoiceCardBaseClass,
    pickerChoiceCardIdleClass,
    pickerChoiceCardSelectedClass,
    pickerChoiceCardSelectedWarningClass,
    pickerGroupLabelClass,
    pickerHintClass,
    pickerProgressTrackClass,
    pickerSeatAvailableClass,
    pickerSeatButtonBaseClass,
    pickerSeatOccupiedClass,
    pickerSeatSelectedClass,
    pickerSectionLabelClass,
    pickerTooltipClass,
    pickerWarningHintClass,
} from "@/components/ui/pickerSurface";
import { pageInsetSurfaceClass, pageMutedTextClass } from "@/components/ui/pageSurface";
import { formatAmount } from "./shared";
import type { ImportDetail, RowDraft } from "./types";

type CompactImportAllocationPickerProps = {
    branchId: string;
    sessionId: string;
    rowId: string;
    draft: RowDraft;
    branchContext: ImportDetail["branchContext"];
    feeLinked: boolean;
    onDraftChange: (field: keyof RowDraft, value: string) => void;
    onFeeLinkChange: (linked: boolean) => void;
};

type AvailabilityState = {
    key: string;
    data: ImportAvailabilityPreview | null;
    error: string | null;
};

function key(value: string | undefined | null) {
    return (value ?? "").trim().toLocaleLowerCase("en-IN");
}

function timeRange(shift: { startTime: string | null; endTime: string | null }) {
    if (!shift.startTime && !shift.endTime) return "Flexible";
    return [shift.startTime, shift.endTime].filter(Boolean).join(" - ");
}

function capacityBarColor(shift: ImportAvailabilityShift) {
    if (shift.isFull) return "bg-[color:var(--ui-tone-danger-progress)]";
    if (shift.occupancyPercent >= 70) return "bg-[color:var(--ui-tone-warning-progress)]";
    return "bg-[color:var(--ui-tone-success-progress)]";
}

export function CompactImportAllocationPicker({
    branchId,
    sessionId,
    rowId,
    draft,
    branchContext,
    feeLinked,
    onDraftChange,
    onFeeLinkChange,
}: CompactImportAllocationPickerProps) {
    const [availabilityState, setAvailabilityState] = useState<AvailabilityState>({
        key: "",
        data: null,
        error: null,
    });
    const [hoveredSeatId, setHoveredSeatId] = useState<string | null>(null);
    const selectedIds = useMemo(() => allocationSelectionFromDraft(draft, branchContext), [branchContext, draft]);
    const selectedShiftIdsKey = selectedIds.shiftIds.join(",");
    const selectedShiftKey = selectedIds.multiShiftId ?? selectedIds.shiftIds[0] ?? "";
    const availabilityRequestKey = useMemo(
        () => [branchId, sessionId, rowId, selectedShiftIdsKey, selectedIds.multiShiftId ?? ""].join("|"),
        [branchId, rowId, selectedIds.multiShiftId, selectedShiftIdsKey, sessionId]
    );
    const loading = availabilityState.key !== availabilityRequestKey;
    const availability = loading ? null : availabilityState.data;
    const error = loading ? null : availabilityState.error;

    useEffect(() => {
        let alive = true;
        const shiftIds = selectedShiftIdsKey ? selectedShiftIdsKey.split(",") : [];
        importSessions.availability<ImportAvailabilityPreview>(branchId, sessionId, {
            rowId,
            shiftIds,
            multiShiftId: selectedIds.multiShiftId,
        })
            .then(result => {
                if (alive) setAvailabilityState({ key: availabilityRequestKey, data: result, error: null });
            })
            .catch(loadError => {
                if (!alive) return;
                setAvailabilityState({
                    key: availabilityRequestKey,
                    data: null,
                    error: loadError instanceof Error ? loadError.message : "Failed to load seat availability.",
                });
            });

        return () => {
            alive = false;
        };
    }, [availabilityRequestKey, branchId, rowId, selectedIds.multiShiftId, selectedShiftIdsKey, sessionId]);

    const primaryShifts = availability?.shifts.filter(shift => shift.type === "PRIMARY") ?? [];
    const multiShifts = availability?.shifts.filter(shift => shift.type === "MULTISHIFT") ?? [];
    const currentSeatLabel = draft.seat.trim();

    const chooseShift = (shift: ImportAvailabilityShift) => {
        if (shift.type === "MULTISHIFT") {
            const selected = selectedIds.multiShiftId === (shift.multiShiftId ?? shift.shiftId);
            onDraftChange("multiShift", selected ? "" : shift.name);
        } else {
            const selected = selectedIds.shiftIds.includes(shift.shiftId);
            onDraftChange("shift", selected ? "" : shift.name);
        }
    };

    const toggleFeeLink = (linked: boolean) => {
        onFeeLinkChange(linked);
    };

    const renderShiftCard = (shift: ImportAvailabilityShift) => {
        const id = shift.type === "MULTISHIFT" ? shift.multiShiftId ?? shift.shiftId : shift.shiftId;
        const selected = selectedShiftKey === id;
        const disabled = shift.isFull && !selected;
        const selectedClass = shift.type === "MULTISHIFT" ? pickerChoiceCardSelectedWarningClass : pickerChoiceCardSelectedClass;

        return (
            <button
                key={`${shift.type}-${id}`}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                aria-label={`${shift.name}, ${shift.available} seats free${shift.isFull ? ", full" : ""}`}
                onClick={() => chooseShift(shift)}
                className={cn(
                    pickerChoiceCardBaseClass,
                    selected ? selectedClass : pickerChoiceCardIdleClass,
                    disabled && "cursor-not-allowed opacity-60"
                )}
            >
                <span className={cn(
                    pickerCheckBoxClass,
                    selected
                        ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                        : "border-[color:var(--ui-form-field-border)]"
                )}>
                    {selected && <Check className="h-3 w-3" />}
                </span>
                <div className="pr-8">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[color:var(--text-primary)]">{shift.name}</p>
                        {shift.type === "MULTISHIFT" && <Badge variant="purple">bundle</Badge>}
                        {shift.isFull && <Badge variant="danger">full</Badge>}
                    </div>
                    <p className={cn("mt-1 text-xs", pageMutedTextClass)}>{timeRange(shift)} / {formatAmount(shift.price)}</p>
                    {shift.componentShiftNames?.length ? (
                        <p className={cn("mt-1 text-xs", pageMutedTextClass)}>{shift.componentShiftNames.join(", ")}</p>
                    ) : null}
                </div>
                <div className="mt-3">
                    <div className={pickerProgressTrackClass}>
                        <div className={cn("h-full rounded-full", capacityBarColor(shift))} style={{ width: `${Math.max(0, Math.min(100, shift.occupancyPercent))}%` }} />
                    </div>
                    <p className={cn("mt-1 text-[10px]", pageMutedTextClass)}>
                        {shift.available} free, {shift.stagedUsed} staged in this import
                    </p>
                </div>
            </button>
        );
    };

    return (
        <div className={cn("space-y-4 p-4", pageInsetSurfaceClass)}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p className={pickerSectionLabelClass}>Seat and shift</p>
                    <p className={cn("mt-1 text-xs", pageMutedTextClass)}>Choose shift or bundle first, then pick an available seat.</p>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                    <input
                        type="checkbox"
                        checked={feeLinked}
                        onChange={event => toggleFeeLink(event.target.checked)}
                        className="h-4 w-4 rounded border-[color:var(--ui-form-field-border)] bg-[color:var(--ui-form-field-bg)]"
                    />
                    <span>Link fee to selected price</span>
                </label>
            </div>

            {loading && (
                <div className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading availability...
                </div>
            )}

            {error && <div className={pickerWarningHintClass}>{error}</div>}

            {!loading && !error && (
                <>
                    <div className="space-y-3">
                        {primaryShifts.length > 0 && (
                            <div className="space-y-2">
                                <p className={pickerGroupLabelClass}>
                                    <span className="inline-block h-2 w-2 rounded-full bg-[color:var(--ui-badge-cyan-text)]" />
                                    Shifts
                                </p>
                                <div className="grid gap-2 md:grid-cols-2">
                                    {primaryShifts.map(renderShiftCard)}
                                </div>
                            </div>
                        )}
                        {multiShifts.length > 0 && (
                            <div className="space-y-2">
                                <p className={pickerGroupLabelClass}>
                                    <Layers className="h-3 w-3" />
                                    Bundles
                                </p>
                                <div className="grid gap-2 md:grid-cols-2">
                                    {multiShifts.map(renderShiftCard)}
                                </div>
                            </div>
                        )}
                    </div>

                    {!availability?.seatMap && (
                        <p className={pickerHintClass}>Select a shift or bundle to see seats.</p>
                    )}

                    {availability?.seatMap && (
                        <div className="space-y-3">
                            <div className="flex items-center justify-between gap-3">
                                <p className={pickerSectionLabelClass}>Seats</p>
                                <p className="text-[10px] text-[color:var(--text-muted)]">
                                    <span className="font-semibold text-[color:var(--ui-tone-success-text)]">{availability.seatMap.availableCount}</span> free
                                    <span className="mx-1">/</span>
                                    <span className="font-semibold text-[color:var(--ui-tone-danger-text)]">{availability.seatMap.occupiedCount}</span> taken
                                </p>
                            </div>
                            <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 lg:grid-cols-10">
                                {availability.seatMap.seats.map(seat => {
                                    const selected = key(seat.label) === key(currentSeatLabel);
                                    const occupied = seat.occupied && !selected;
                                    return (
                                        <div key={seat.seatId} className="group relative">
                                            <button
                                                type="button"
                                                disabled={occupied}
                                                aria-pressed={selected}
                                                aria-label={`${seat.label}${occupied ? ", unavailable" : selected ? ", selected" : ", available"}`}
                                                onMouseEnter={() => setHoveredSeatId(seat.seatId)}
                                                onMouseLeave={() => setHoveredSeatId(null)}
                                                onFocus={() => setHoveredSeatId(seat.seatId)}
                                                onBlur={() => setHoveredSeatId(null)}
                                                onClick={() => onDraftChange("seat", selected ? "" : seat.label)}
                                                className={cn(
                                                    pickerSeatButtonBaseClass,
                                                    selected ? pickerSeatSelectedClass : occupied ? pickerSeatOccupiedClass : pickerSeatAvailableClass
                                                )}
                                            >
                                                {occupied ? <Lock className="h-3 w-3" /> : selected ? <Check className="h-3 w-3" /> : null}
                                                <span>{seat.label}</span>
                                            </button>
                                            {hoveredSeatId === seat.seatId && (seat.occupiedBy || seat.source !== "available") && (
                                                <div className={pickerTooltipClass}>
                                                    {seat.occupiedBy ?? seat.source}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
