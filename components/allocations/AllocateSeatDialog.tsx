"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import {
    formCheckboxClass,
    formControlClass,
    formErrorBannerClass,
    formHelpTextClass,
    formLabelClass,
    formSurfaceClass,
    formSurfaceHoverClass,
} from "@/components/ui/formSurface";
import { FieldError, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { SeatPicker, ShiftCapacity } from "./SeatPicker";
import { cn } from "@/lib/utils";

interface StudentOption {
    id: string;
    name: string;
    phone?: string | null;
}

interface AllocateSeatDialogProps {
    isOpen: boolean;
    branchId: string;
    preselectedStudentId?: string;
    preselectedStudentName?: string;
    preselectedSeatId?: string;
    preselectedShiftIds?: string[];
    preselectedShiftNames?: string[];
    preselectedMultiShiftId?: string;
    preselectedMultiShiftName?: string;
    onClose: () => void;
    onSuccess: () => void;
}

export function AllocateSeatDialog({
    isOpen,
    branchId,
    preselectedStudentId,
    preselectedStudentName,
    preselectedSeatId,
    preselectedShiftIds,
    preselectedShiftNames,
    preselectedMultiShiftId,
    preselectedMultiShiftName,
    onClose,
    onSuccess,
}: AllocateSeatDialogProps) {
    // Student picking
    const [students, setStudents] = useState<StudentOption[]>([]);
    const [studentId, setStudentId] = useState(preselectedStudentId ?? "");
    const [studentName, setStudentName] = useState(preselectedStudentName ?? "");
    const [studentSearch, setStudentSearch] = useState("");

    // Shift selection state
    const [selectedShiftIds, setSelectedShiftIds] = useState<string[]>(preselectedShiftIds ?? []);
    const [selectedShiftNames, setSelectedShiftNames] = useState<string[]>(preselectedShiftNames ?? []);
    const [selectedSeatId, setSelectedSeatId] = useState<string | null>(preselectedSeatId ?? null);
    // Multi-shift tracking
    const [selectedMultiShiftId, setSelectedMultiShiftId] = useState<string | null>(preselectedMultiShiftId ?? null);
    const [selectedMultiShiftName, setSelectedMultiShiftName] = useState<string | null>(preselectedMultiShiftName ?? null);
    const [linkFeeToSelection, setLinkFeeToSelection] = useState(false);

    // Submission
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<"student" | "selection">();

    useEffect(() => {
        if (!isOpen) return;
        setSelectedShiftIds(preselectedShiftIds ?? []);
        setSelectedShiftNames(preselectedShiftNames ?? []);
        setSelectedSeatId(preselectedSeatId ?? null);
        setSelectedMultiShiftId(preselectedMultiShiftId ?? null);
        setSelectedMultiShiftName(preselectedMultiShiftName ?? null);
        setLinkFeeToSelection(false);
        setSubmitError(null);
        setStudentId(preselectedStudentId ?? "");
        setStudentName(preselectedStudentName ?? "");
        setStudentSearch("");
        resetFieldErrors();
    }, [
        isOpen,
        preselectedSeatId,
        preselectedShiftIds,
        preselectedShiftNames,
        preselectedMultiShiftId,
        preselectedMultiShiftName,
        preselectedStudentId,
        preselectedStudentName,
        resetFieldErrors,
    ]);

    const feeLinkLabel = selectedMultiShiftId
        ? "selected multi-shift"
        : selectedShiftIds.length === 1
            ? "selected shift"
            : null;

    useEffect(() => {
        if (!feeLinkLabel) setLinkFeeToSelection(false);
    }, [feeLinkLabel]);

    useEffect(() => {
        if (!isOpen || preselectedStudentId) return;
        fetch(`/api/branches/${branchId}/students?status=ACTIVE&all=true`)
            .then(async response => {
                const body = await response.json();
                if (!response.ok || !Array.isArray(body?.items)) {
                    throw new Error(body?.error ?? "Failed to load students");
                }
                setStudents(body.items);
            })
            .catch(error => {
                setStudents([]);
                setSubmitError(error instanceof Error ? error.message : "Failed to load students");
            });
    }, [isOpen, branchId, preselectedStudentId]);

    const handleToggleShift = (shift: ShiftCapacity) => {
        markTouched("selection");
        setSelectedSeatId(prev => preselectedSeatId && prev === preselectedSeatId ? preselectedSeatId : null);
        setSubmitError(null);

        if (shift.type === "MULTISHIFT") {
            if (selectedMultiShiftId === shift.shiftId) {
                // deselect
                setSelectedMultiShiftId(null);
                setSelectedMultiShiftName(null);
                setSelectedShiftIds([]);
                setSelectedShiftNames([]);
            } else {
                // select multishift - store component IDs for the submission payload
                setSelectedMultiShiftId(shift.shiftId);
                setSelectedMultiShiftName(shift.name);
                setSelectedShiftIds(shift.componentShiftIds ?? []);
                setSelectedShiftNames([shift.name]);
            }
        } else {
            // Primary shift toggle - clear any active multi-shift selection first
            setSelectedMultiShiftId(null);
            setSelectedMultiShiftName(null);
            setSelectedShiftIds(prev => {
                const exists = prev.includes(shift.shiftId);
                if (exists) {
                    setSelectedShiftNames(names => names.filter(n => n !== shift.name));
                    return prev.filter(id => id !== shift.shiftId);
                } else {
                    setSelectedShiftNames(names => [...names, shift.name]);
                    return [...prev, shift.shiftId];
                }
            });
        }
    };

    const validateForm = () => {
        const errors: Partial<Record<"student" | "selection", string>> = {};
        const sid = preselectedStudentId ?? studentId;
        if (!sid) errors.student = "Select an active student.";
        if (!selectedSeatId || selectedShiftIds.length === 0) {
            errors.selection = "Select at least one shift and a seat.";
        }
        return { errors, sid };
    };

    const handleConfirm = async () => {
        markSubmitted();
        setSubmitError(null);
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean) || !result.sid) return;
        const sid = result.sid;

        setSubmitting(true);

        try {
            const res = await fetch(`/api/branches/${branchId}/seat-allocations`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    studentId: sid,
                    seatId: selectedSeatId,
                    shiftIds: selectedShiftIds,
                    ...(selectedMultiShiftId ? { multiShiftId: selectedMultiShiftId } : {}),
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to allocate seat");
            }

            if (linkFeeToSelection) {
                const feeRes = await fetch(`/api/branches/${branchId}/students`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: sid,
                        ...(selectedMultiShiftId
                            ? {
                                feeLinkedShiftId: null,
                                feeLinkedMultiShiftId: selectedMultiShiftId,
                            }
                            : {
                                feeLinkedShiftId: selectedShiftIds[0],
                                feeLinkedMultiShiftId: null,
                            }),
                    }),
                });

                if (!feeRes.ok) {
                    const data = await feeRes.json().catch(() => ({}));
                    throw new Error(data.error || "Seat allocated, but fee link failed.");
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

    const effectiveStudentId = preselectedStudentId ?? studentId;
    const effectiveStudentName = preselectedStudentName ?? studentName;
    const hasStudent = !!effectiveStudentId;
    const validation = validateForm();
    const studentError = visibleError("student", validation.errors);
    const selectionError = visibleError("selection", validation.errors);

    const filteredStudents = students.filter(s =>
        s.name.toLowerCase().includes(studentSearch.toLowerCase()) ||
        (s.phone && s.phone.includes(studentSearch))
    );

    const confirmLabel = selectedMultiShiftName
        ? `Confirm (${selectedMultiShiftName})`
        : selectedShiftIds.length > 1
            ? `Confirm (${selectedShiftIds.length} shifts)`
            : "Confirm";

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="Allocate seat"
            description={effectiveStudentName
                ? `Allocate a seat for ${effectiveStudentName}${selectedShiftNames.length > 0 ? ` / ${selectedShiftNames.join(", ")}` : ""}.`
                : "Select an active student, shifts, and an available seat."}
            closeLabel="Close allocate seat dialog"
            closeDisabled={submitting}
            className="max-w-2xl"
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose} disabled={submitting} className="h-8 px-4 text-sm">
                        Cancel
                    </Button>
                    <Button onClick={handleConfirm} disabled={submitting} className="h-8 px-5 text-sm">
                        {submitting
                            ? <><Loader2 size={12} className="mr-1.5 animate-spin" aria-hidden="true" /> Allocating...</>
                            : confirmLabel
                        }
                    </Button>
                </>
            )}
        >
                <div>
                    {/* Student picker (only when not preselected) */}
                    {!hasStudent && (
                        <div
                            className="mb-6 space-y-3"
                            role="group"
                            aria-labelledby="allocate-seat-student-label"
                            aria-describedby={studentError ? "allocate-seat-student-error" : undefined}
                        >
                            <p id="allocate-seat-student-label" className={formLabelClass}>Select an active student:</p>
                            <label htmlFor="allocate-seat-student-search" className="sr-only">Search active students</label>
                            <input
                                id="allocate-seat-student-search"
                                type="text"
                                placeholder="Search by name or phone..."
                                value={studentSearch}
                                onChange={e => setStudentSearch(e.target.value)}
                                className={cn(formControlClass, "px-3 py-2 text-sm")}
                                data-dialog-initial-focus
                            />
                            <div className="max-h-48 space-y-1.5 overflow-y-auto pr-2" role="group" aria-label="Active students">
                                {filteredStudents.map(s => (
                                    <button
                                        key={s.id}
                                        type="button"
                                        onClick={() => { markTouched("student"); setStudentId(s.id); setStudentName(s.name); }}
                                        className={cn("w-full cursor-pointer px-3 py-2.5 text-left", formSurfaceClass, formSurfaceHoverClass)}
                                        aria-pressed={studentId === s.id}
                                    >
                                        <p className="text-sm font-medium text-[color:var(--ui-form-label-strong)]">{s.name}</p>
                                        {s.phone && <p className={cn("text-xs", formHelpTextClass)}>{s.phone}</p>}
                                    </button>
                                ))}
                                {filteredStudents.length === 0 && (
                                    <p className={cn("py-4 text-center text-sm", formHelpTextClass)}>No active students found.</p>
                                )}
                            </div>
                            <FieldError id="allocate-seat-student-error" error={studentError} />
                        </div>
                    )}

                    {hasStudent && (
                        <div
                            className="space-y-4"
                            role="group"
                            aria-label="Seat and shift selection"
                            aria-describedby={selectionError ? "allocate-seat-selection-error" : undefined}
                        >
                            <SeatPicker
                                branchId={branchId}
                                studentId={effectiveStudentId}
                                selectedShiftIds={selectedShiftIds}
                                selectedMultiShiftId={selectedMultiShiftId}
                                selectedSeatId={selectedSeatId}
                                onToggleShift={handleToggleShift}
                                onSelectSeat={(seatId) => { markTouched("selection"); setSelectedSeatId(seatId); }}
                            />
                            <FieldError id="allocate-seat-selection-error" error={selectionError} />

                            {feeLinkLabel && (
                                <label className={cn("group flex w-max cursor-pointer items-center gap-3 px-4 py-3", formSurfaceClass, formSurfaceHoverClass)}>
                                    <input
                                        type="checkbox"
                                        checked={linkFeeToSelection}
                                        onChange={(e) => setLinkFeeToSelection(e.target.checked)}
                                        className={formCheckboxClass}
                                    />
                                    <span className="text-sm font-medium text-[color:var(--ui-form-label-strong)] transition-colors group-hover:text-[color:var(--ui-form-accent-hover)]">
                                        Link monthly fee to {feeLinkLabel} price
                                    </span>
                                </label>
                            )}

                            {submitError && (
                                <div role="alert" className={cn("p-3 text-sm", formErrorBannerClass)}>
                                    {submitError}
                                </div>
                            )}
                        </div>
                    )}
                </div>
        </Dialog>
    );
}
