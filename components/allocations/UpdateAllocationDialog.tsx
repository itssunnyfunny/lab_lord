"use client";

import { useEffect, useState } from "react";
import { Loader2, ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import {
    formCheckboxClass,
    formControlClass,
    formErrorBannerClass,
    formHelpTextClass,
    formIconClass,
    formLabelClass,
    formSurfaceClass,
} from "@/components/ui/formSurface";
import { FieldError, fieldErrorClass, fieldErrorProps, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { SeatPicker, ShiftCapacity } from "./SeatPicker";
import { FORM_LIMITS, parseIntegerField } from "@/lib/formValidation";
import { cn } from "@/lib/utils";

interface UpdateAllocationDialogProps {
    isOpen: boolean;
    branchId: string;
    allocationId: string;
    allocationIds: string[];
    studentId: string;
    studentName: string;
    currentSeatId: string;
    currentFee: number | null;
    currentShiftIds?: string[];
    currentMultiShiftId?: string | null;
    onClose: () => void;
    onSuccess: () => void;
}

export function UpdateAllocationDialog({
    isOpen,
    branchId,
    allocationId,
    allocationIds,
    studentId,
    studentName,
    currentSeatId,
    currentFee,
    currentShiftIds = [],
    currentMultiShiftId = null,
    onClose,
    onSuccess,
}: UpdateAllocationDialogProps) {
    const [selectedShiftIds, setSelectedShiftIds] = useState<string[]>(currentShiftIds);
    const [selectedShiftNames, setSelectedShiftNames] = useState<string[]>([]);
    const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
    const [selectedMultiShiftId, setSelectedMultiShiftId] = useState<string | null>(currentMultiShiftId);
    const [selectedMultiShiftName, setSelectedMultiShiftName] = useState<string | null>(null);
    const [newFee, setNewFee] = useState<string>("");
    const [linkFeeToSelection, setLinkFeeToSelection] = useState(false);

    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<"selection" | "fee">();

    useEffect(() => {
        if (!isOpen) return;
        setSelectedShiftIds(currentShiftIds);
        setSelectedShiftNames([]);
        setSelectedSeatId(null);
        setSelectedMultiShiftId(currentMultiShiftId);
        setSelectedMultiShiftName(null);
        setNewFee("");
        setLinkFeeToSelection(false);
        setSubmitError(null);
        resetFieldErrors();
    }, [isOpen, currentShiftIds, currentMultiShiftId, resetFieldErrors]);

    const feeLinkLabel = selectedMultiShiftId
        ? "selected multi-shift"
        : selectedShiftIds.length === 1
            ? "selected shift"
            : null;

    useEffect(() => {
        if (!feeLinkLabel) setLinkFeeToSelection(false);
    }, [feeLinkLabel]);

    const handleToggleShift = (shift: ShiftCapacity) => {
        markTouched("selection");
        setSelectedSeatId(null);
        setSubmitError(null);

        if (shift.type === "MULTISHIFT") {
            if (selectedMultiShiftId === shift.shiftId) {
                setSelectedMultiShiftId(null);
                setSelectedMultiShiftName(null);
                setSelectedShiftIds([]);
                setSelectedShiftNames([]);
            } else {
                setSelectedMultiShiftId(shift.shiftId);
                setSelectedMultiShiftName(shift.name);
                setSelectedShiftIds(shift.componentShiftIds ?? []);
                setSelectedShiftNames([shift.name]);
            }
        } else {
            setSelectedMultiShiftId(null);
            setSelectedMultiShiftName(null);
            setSelectedShiftIds(prev => {
                const exists = prev.includes(shift.shiftId);
                if (exists) {
                    setSelectedShiftNames(names => names.filter(n => n !== shift.name));
                    return prev.filter(id => id !== shift.shiftId);
                }

                setSelectedShiftNames(names => [...names, shift.name]);
                return [...prev, shift.shiftId];
            });
        }
    };

    const validateForm = () => {
        const errors: Partial<Record<"selection" | "fee", string>> = {};
        if (!selectedSeatId || selectedShiftIds.length === 0) {
            errors.selection = "Select at least one shift and a seat.";
        }
        const newFeeResult = newFee.trim() !== ""
            ? parseIntegerField(newFee, "Monthly fee", { min: 0, max: FORM_LIMITS.moneyMax })
            : null;
        if (newFeeResult && !newFeeResult.ok) errors.fee = newFeeResult.error;
        if (Object.values(errors).some(Boolean)) return { errors, newFeeResult: null };
        return { errors, newFeeResult };
    };

    const validation = validateForm();
    const selectionError = visibleError("selection", validation.errors);
    const feeError = visibleError("fee", validation.errors);

    const handleConfirm = async () => {
        markSubmitted();
        setSubmitError(null);
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean)) {
            return;
        }
        const newFeeResult = result.newFeeResult;

        setSubmitting(true);

        try {
            const res = await fetch(`/api/seat-allocations/${allocationId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    seatId: selectedSeatId,
                    studentId,
                    shiftIds: selectedShiftIds,
                    allocationIds,
                    ...(selectedMultiShiftId ? { multiShiftId: selectedMultiShiftId } : {}),
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to update allocation");
            }

            if (linkFeeToSelection || newFee.trim() !== "") {
                const feeRes = await fetch(`/api/branches/${branchId}/students`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: studentId,
                        ...(linkFeeToSelection && selectedMultiShiftId
                            ? {
                                feeLinkedShiftId: null,
                                feeLinkedMultiShiftId: selectedMultiShiftId,
                            }
                            : linkFeeToSelection && selectedShiftIds.length === 1
                                ? {
                                    feeLinkedShiftId: selectedShiftIds[0],
                                    feeLinkedMultiShiftId: null,
                                }
                                : {
                                    monthlyFee: newFeeResult?.ok ? newFeeResult.value : undefined,
                                    feeLinkedShiftId: null,
                                    feeLinkedMultiShiftId: null,
                                }),
                    }),
                });

                if (!feeRes.ok) {
                    const data = await feeRes.json().catch(() => ({}));
                    throw new Error(data.error || "Allocation updated, but fee update failed.");
                }
            }

            onSuccess();
            resetFieldErrors();
            onClose();
        } catch (e: unknown) {
            setSubmitError(e instanceof Error ? e.message : "Something went wrong.");
        } finally {
            setSubmitting(false);
        }
    };

    if (!isOpen) return null;

    const confirmLabel = selectedMultiShiftName
        ? `Update (${selectedMultiShiftName})`
        : selectedShiftIds.length > 1
            ? `Update (${selectedShiftIds.length} shifts)`
            : "Update";

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="Change seat or shift"
            description={`Update the allocation for ${studentName}${selectedShiftNames.length > 0 ? ` / ${selectedShiftNames.join(", ")}` : ""}.`}
            closeLabel="Close change allocation dialog"
            closeDisabled={submitting}
            className="max-w-2xl"
            icon={<ArrowRightLeft size={18} className="text-[color:var(--ui-badge-cyan-text)]" aria-hidden="true" />}
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose} disabled={submitting} className="h-8 px-4 text-sm">
                        Cancel
                    </Button>
                    <Button onClick={handleConfirm} disabled={submitting} className="h-8 px-5 text-sm">
                        {submitting
                            ? <><Loader2 size={12} className="mr-1.5 animate-spin" aria-hidden="true" /> Updating...</>
                            : confirmLabel
                        }
                    </Button>
                </>
            )}
        >
                <div
                    role="group"
                    aria-label="Seat and shift selection"
                    aria-describedby={selectionError ? "update-allocation-selection-error" : undefined}
                >
                    <SeatPicker
                        branchId={branchId}
                        studentId={studentId}
                        selectedShiftIds={selectedShiftIds}
                        selectedMultiShiftId={selectedMultiShiftId}
                        selectedSeatId={selectedSeatId}
                        onToggleShift={handleToggleShift}
                        onSelectSeat={(seatId) => { markTouched("selection"); setSelectedSeatId(seatId); }}
                        excludeAllocationIds={allocationIds}
                        currentSeatId={currentSeatId}
                    />
                    <FieldError id="update-allocation-selection-error" error={selectionError} />

                    {feeLinkLabel && (
                        <div className={cn("mt-5 space-y-3 p-4", formSurfaceClass)}>
                            <div className="flex items-center gap-3">
                                <label htmlFor="update-allocation-fee" className={cn("whitespace-nowrap text-xs", formHelpTextClass)}>
                                    Monthly fee:{" "}
                                    <span className="font-medium text-[color:var(--ui-form-label-strong)]">
                                        {currentFee != null ? `Rs.${currentFee}` : "--"}
                                    </span>
                                </label>
                                <div className="relative flex-1">
                                    <span className={cn("absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm", formIconClass)}>Rs.</span>
                                    <input
                                        id="update-allocation-fee"
                                        type="number"
                                        min={0}
                                        max={FORM_LIMITS.moneyMax}
                                        step={1}
                                        inputMode="numeric"
                                        value={newFee}
                                        disabled={linkFeeToSelection}
                                        onChange={e => { setNewFee(e.target.value); setSubmitError(null); }}
                                        onBlur={() => markTouched("fee")}
                                        placeholder={linkFeeToSelection ? "Linked to shift price" : "Update fee (optional)"}
                                        className={cn(formControlClass, "py-2 pl-10 pr-3 text-sm", fieldErrorClass(feeError))}
                                        {...fieldErrorProps("update-allocation-fee-error", feeError)}
                                    />
                                </div>
                            </div>
                            <FieldError id="update-allocation-fee-error" error={feeError} />

                            <label className="group flex w-max cursor-pointer items-center gap-3">
                                <input
                                    type="checkbox"
                                    checked={linkFeeToSelection}
                                    onChange={(e) => setLinkFeeToSelection(e.target.checked)}
                                    className={formCheckboxClass}
                                />
                                <span className={cn("text-sm font-medium transition-colors group-hover:text-[color:var(--ui-form-accent-hover)]", formLabelClass)}>
                                    Link monthly fee to {feeLinkLabel} price
                                </span>
                            </label>
                        </div>
                    )}

                    {submitError && (
                        <div role="alert" className={cn("mt-4 p-3 text-sm", formErrorBannerClass)}>
                            {submitError}
                        </div>
                    )}
                </div>
        </Dialog>
    );
}
