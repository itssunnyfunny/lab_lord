"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import {
    formCheckboxClass,
    formControlClass,
    formErrorBannerClass,
    formLabelClass,
    formRequiredClass,
    formSuccessBannerClass,
    formSurfaceClass,
    formWarningBannerClass,
} from "@/components/ui/formSurface";
import { FieldError, fieldErrorClass, fieldErrorProps, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { students } from "@/lib/api/students";
import type { CapabilityDecision, CreateStudentDto } from "@/types";
import { SeatPicker } from "@/components/allocations/SeatPicker";
import { FORM_LIMITS, parseIntegerField, validateRequiredPhone, validateRequiredText } from "@/lib/formValidation";
import { cn } from "@/lib/utils";

interface AddStudentDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: (student: unknown) => void;
    branchId: string;
    allocationDecision: CapabilityDecision;
}

export function AddStudentDialog({
    isOpen,
    onClose,
    onSuccess,
    branchId,
    allocationDecision,
}: AddStudentDialogProps) {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [formData, setFormData] = useState<CreateStudentDto>({
        name: "",
        phone: "",
        monthlyFee: undefined,
        admissionFee: undefined,
    });

    // Integrated allocation state
    const [wantsAllocation, setWantsAllocation] = useState(false);
    const [selectedShiftIds, setSelectedShiftIds] = useState<string[]>([]);   // always primary shift IDs
    const [selectedMultiShiftId, setSelectedMultiShiftId] = useState<string | null>(null);
    const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
    const [createdStudentId, setCreatedStudentId] = useState<string | null>(null);
    const [linkFeeToSelection, setLinkFeeToSelection] = useState(false);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<"name" | "phone" | "monthlyFee" | "admissionFee" | "allocation">();

    useEffect(() => {
        if (!isOpen) {
            setError(null);
            resetFieldErrors();
            setFormData({ name: "", phone: "", monthlyFee: undefined, admissionFee: undefined });
            setWantsAllocation(false);
            setSelectedShiftIds([]);
            setSelectedMultiShiftId(null);
            setSelectedSeatId(null);
            setCreatedStudentId(null);
            setLinkFeeToSelection(false);
        }
    }, [isOpen, resetFieldErrors]);

    useEffect(() => {
        if (!isOpen) return;
        async function loadBranchDefaults() {
            try {
                const res = await fetch(`/api/branches/${branchId}`);
                if (!res.ok) return;
                const branch = await res.json();
                setFormData(prev => ({
                    ...prev,
                    admissionFee: prev.admissionFee ?? branch.defaultAdmissionFee ?? undefined,
                }));
            } catch (err) {
                console.error(err);
            }
        }
        loadBranchDefaults();
    }, [branchId, isOpen]);

    useEffect(() => {
        if (allocationDecision.allowed) return;

        setWantsAllocation(false);
        setSelectedShiftIds([]);
        setSelectedMultiShiftId(null);
        setSelectedSeatId(null);
        setLinkFeeToSelection(false);
    }, [allocationDecision.allowed]);

    const feeLinkLabel = selectedMultiShiftId
        ? "selected multi-shift"
        : selectedShiftIds.length === 1
            ? "selected shift"
            : null;

    useEffect(() => {
        if (!feeLinkLabel) setLinkFeeToSelection(false);
    }, [feeLinkLabel]);

    if (!isOpen) return null;

    const validateForm = () => {
        const errors: Partial<Record<"name" | "phone" | "monthlyFee" | "admissionFee" | "allocation", string>> = {};
        let payload: CreateStudentDto | null = null;

        if (!createdStudentId) {
            const nameResult = validateRequiredText(formData.name, "Student name");
            const phoneResult = validateRequiredPhone(formData.phone);
            const monthlyFeeResult = parseIntegerField(formData.monthlyFee, "Monthly fee", {
                min: 0,
                max: FORM_LIMITS.moneyMax,
            });
            const admissionFeeResult = parseIntegerField(formData.admissionFee, "Admission fee", {
                min: 0,
                max: FORM_LIMITS.moneyMax,
            });

            if (!nameResult.ok) errors.name = nameResult.error;
            if (!phoneResult.ok) errors.phone = phoneResult.error;
            if (!monthlyFeeResult.ok) errors.monthlyFee = monthlyFeeResult.error;
            if (!admissionFeeResult.ok) errors.admissionFee = admissionFeeResult.error;

            if (nameResult.ok && phoneResult.ok && monthlyFeeResult.ok && admissionFeeResult.ok) {
                payload = {
                    name: nameResult.value,
                    phone: phoneResult.value,
                    ...(monthlyFeeResult.value !== undefined ? { monthlyFee: monthlyFeeResult.value } : {}),
                    ...(admissionFeeResult.value !== undefined ? { admissionFee: admissionFeeResult.value } : {}),
                };
            }
        }

        if (wantsAllocation && allocationDecision.allowed && (selectedShiftIds.length === 0 || !selectedSeatId)) {
            errors.allocation = "Select at least one shift and a seat, or uncheck allocation.";
        }

        return { errors, payload };
    };

    const validation = validateForm();
    const nameError = visibleError("name", validation.errors);
    const phoneError = visibleError("phone", validation.errors);
    const monthlyFeeError = visibleError("monthlyFee", validation.errors);
    const admissionFeeError = visibleError("admissionFee", validation.errors);
    const allocationError = visibleError("allocation", validation.errors);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        markSubmitted();
        setError(null);

        if (wantsAllocation && !allocationDecision.allowed) {
            setError(allocationDecision.reason);
            return;
        }

        const result = validateForm();
        if (Object.values(result.errors).some(Boolean)) {
            return;
        }
        const payload = result.payload;

        setIsLoading(true);

        try {
            // 1. Create student if not already created (handles race-condition retries cleanly)
            let studentToAllocateTo = createdStudentId;
            let finalStudentObj;

            if (!studentToAllocateTo) {
                if (!payload) throw new Error("Student details are required.");
                const studentPayload: CreateStudentDto = {
                    ...payload,
                    ...(wantsAllocation && allocationDecision.allowed && linkFeeToSelection && selectedMultiShiftId
                        ? {
                            monthlyFee: undefined,
                            feeLinkedShiftId: null,
                            feeLinkedMultiShiftId: selectedMultiShiftId,
                        }
                        : wantsAllocation && allocationDecision.allowed && linkFeeToSelection && selectedShiftIds.length === 1
                            ? {
                                monthlyFee: undefined,
                                feeLinkedShiftId: selectedShiftIds[0],
                                feeLinkedMultiShiftId: null,
                            }
                            : {
                                feeLinkedShiftId: null,
                                feeLinkedMultiShiftId: null,
                            }),
                };

                finalStudentObj = await students.create(branchId, studentPayload);
                studentToAllocateTo = finalStudentObj.id;
                setCreatedStudentId(studentToAllocateTo);
            }

            // 2. Allocate seat if toggled
            if (wantsAllocation && allocationDecision.allowed && selectedShiftIds.length > 0 && selectedSeatId && studentToAllocateTo) {
                const res = await fetch(`/api/branches/${branchId}/seat-allocations`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        studentId: studentToAllocateTo,
                        seatId: selectedSeatId,
                        shiftIds: selectedShiftIds,   // always primary shift IDs
                        ...(selectedMultiShiftId ? { multiShiftId: selectedMultiShiftId } : {}),
                    }),
                });

                if (!res.ok) {
                    const data = await res.json();
                    throw new Error(data.error || "Student created, but seat allocation failed. Please select another seat and try again.");
                }
            }

            // Success completely
            onSuccess(finalStudentObj || { id: studentToAllocateTo, name: payload?.name ?? formData.name.trim() });
            onClose();
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Something went wrong.";
            setError(message);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="Add new student"
            description={allocationDecision.blocker === "permission"
                ? "Create the student profile."
                : "Create the student profile and optionally allocate a seat."}
            closeLabel="Close add student dialog"
            closeDisabled={isLoading}
            className="max-w-2xl"
            footer={(
                <>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={isLoading}>
                        Cancel
                    </Button>
                    <Button type="submit" form="add-student-form" disabled={isLoading} className="min-w-[140px]">
                        {isLoading ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Saving...</>
                        ) : wantsAllocation && allocationDecision.allowed ? (
                            "Save & Allocate"
                        ) : (
                            "Add Student"
                        )}
                    </Button>
                </>
            )}
        >
                    <form
                        id="add-student-form"
                        onSubmit={handleSubmit}
                        noValidate
                        aria-describedby={error ? "add-student-submit-error" : undefined}
                        className="space-y-6"
                    >
                        {error && (
                            <div id="add-student-submit-error" role="alert" className={cn("p-3 text-sm", formErrorBannerClass)}>
                                {error}
                            </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <label htmlFor="add-student-name" className={formLabelClass}>
                                    Full Name <span className={formRequiredClass}>*</span>
                                </label>
                                <input
                                    id="add-student-name"
                                    type="text"
                                    disabled={!!createdStudentId || isLoading}
                                    value={formData.name}
                                    onChange={(e) => { setFormData({ ...formData, name: e.target.value }); setError(null); }}
                                    onBlur={() => markTouched("name")}
                                    className={cn(formControlClass, "px-3 py-2", fieldErrorClass(nameError))}
                                    placeholder="e.g. John Doe"
                                    data-dialog-initial-focus
                                    maxLength={FORM_LIMITS.nameMax}
                                    {...fieldErrorProps("add-student-name-error", nameError)}
                                />
                                <FieldError id="add-student-name-error" error={nameError} />
                            </div>

                            <div className="space-y-2">
                                <label htmlFor="add-student-phone" className={formLabelClass}>
                                    Phone Number <span className={formRequiredClass}>*</span>
                                </label>
                                <input
                                    id="add-student-phone"
                                    type="tel"
                                    disabled={!!createdStudentId || isLoading}
                                    value={formData.phone || ""}
                                    onChange={(e) => { setFormData({ ...formData, phone: e.target.value }); setError(null); }}
                                    onBlur={() => markTouched("phone")}
                                    className={cn(formControlClass, "px-3 py-2", fieldErrorClass(phoneError))}
                                    placeholder="e.g. +91 98765 43210"
                                    inputMode="tel"
                                    maxLength={24}
                                    {...fieldErrorProps("add-student-phone-error", phoneError)}
                                />
                                <FieldError id="add-student-phone-error" error={phoneError} />
                            </div>

                            <div className="space-y-2">
                                <label htmlFor="add-student-monthly-fee" className={formLabelClass}>
                                    Monthly Fee
                                </label>
                                <input
                                    id="add-student-monthly-fee"
                                    type="number"
                                    disabled={!!createdStudentId || isLoading || linkFeeToSelection}
                                    value={formData.monthlyFee ?? ""}
                                    onChange={(e) => {
                                        setFormData({
                                            ...formData,
                                            monthlyFee: e.target.value ? Number(e.target.value) : undefined,
                                        });
                                        setError(null);
                                    }}
                                    onBlur={() => markTouched("monthlyFee")}
                                    className={cn(formControlClass, "px-3 py-2", fieldErrorClass(monthlyFeeError))}
                                    placeholder={linkFeeToSelection ? "Linked to shift price" : "Branch default"}
                                    min={0}
                                    max={FORM_LIMITS.moneyMax}
                                    step={1}
                                    inputMode="numeric"
                                    {...fieldErrorProps("add-student-monthly-fee-error", monthlyFeeError)}
                                />
                                <FieldError id="add-student-monthly-fee-error" error={monthlyFeeError} />
                            </div>

                            <div className="space-y-2">
                                <label htmlFor="add-student-admission-fee" className={formLabelClass}>
                                    Admission Fee
                                </label>
                                <input
                                    id="add-student-admission-fee"
                                    type="number"
                                    disabled={!!createdStudentId || isLoading}
                                    value={formData.admissionFee ?? ""}
                                    onChange={(e) => {
                                        setFormData({
                                            ...formData,
                                            admissionFee: e.target.value ? Number(e.target.value) : undefined,
                                        });
                                        setError(null);
                                    }}
                                    onBlur={() => markTouched("admissionFee")}
                                    className={cn(formControlClass, "px-3 py-2", fieldErrorClass(admissionFeeError))}
                                    placeholder="One-time"
                                    min={0}
                                    max={FORM_LIMITS.moneyMax}
                                    step={1}
                                    inputMode="numeric"
                                    {...fieldErrorProps("add-student-admission-fee-error", admissionFeeError)}
                                />
                                <FieldError id="add-student-admission-fee-error" error={admissionFeeError} />
                            </div>
                        </div>

                        {createdStudentId && (
                            <div role="status" className={cn("p-3 text-sm", formSuccessBannerClass)}>
                                Student profile saved. Pick a different seat and try allocating again.
                            </div>
                        )}

                        {allocationDecision.blocker !== "permission" && (
                            <>
                                <hr className="border-[color:var(--ui-form-section-divider)]" />

                                <div className="space-y-4">
                                    {allocationDecision.allowed ? (
                                        <label className="group flex w-max cursor-pointer items-center gap-3">
                                            <input
                                                type="checkbox"
                                                checked={wantsAllocation}
                                                onChange={(e) => { setWantsAllocation(e.target.checked); markTouched("allocation"); }}
                                                className={formCheckboxClass}
                                            />
                                            <span className="text-sm font-medium text-[color:var(--ui-form-label-strong)] transition-colors group-hover:text-[color:var(--ui-form-accent-hover)]">
                                                Allocate seat now (Optional)
                                            </span>
                                        </label>
                                    ) : (
                                        <div className={cn("space-y-2 p-3 text-sm", formWarningBannerClass)}>
                                            <label className="flex cursor-not-allowed items-center gap-3">
                                                <input
                                                    type="checkbox"
                                                    checked={false}
                                                    disabled
                                                    aria-describedby="add-student-allocation-unavailable"
                                                    className={formCheckboxClass}
                                                />
                                                <span className="font-medium">Allocate seat now (Optional)</span>
                                            </label>
                                            <p id="add-student-allocation-unavailable">
                                                {allocationDecision.reason}
                                            </p>
                                            {allocationDecision.recoveryHref && (
                                                <Link
                                                    href={allocationDecision.recoveryHref}
                                                    className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
                                                >
                                                    Resolve access
                                                </Link>
                                            )}
                                        </div>
                                    )}

                                    {wantsAllocation && allocationDecision.allowed && (
                                        <div
                                            className={cn("mt-4 p-3 sm:p-5", formSurfaceClass)}
                                            role="group"
                                            aria-label="Seat allocation"
                                            aria-describedby={allocationError ? "add-student-allocation-error" : undefined}
                                        >
                                            <SeatPicker
                                                branchId={branchId}
                                                selectedShiftIds={selectedShiftIds}
                                                selectedSeatId={selectedSeatId}
                                                onToggleShift={(s) => {
                                                    markTouched("allocation");
                                                    setSelectedSeatId(null);
                                                    if (s.type === "MULTISHIFT") {
                                                        // Toggle multi-shift: expand to component primary shift IDs
                                                        if (selectedMultiShiftId === s.shiftId) {
                                                            setSelectedMultiShiftId(null);
                                                            setSelectedShiftIds([]);
                                                        } else {
                                                            setSelectedMultiShiftId(s.shiftId);
                                                            setSelectedShiftIds(s.componentShiftIds ?? []);
                                                        }
                                                    } else {
                                                        // Primary shift toggle - clear any active multi-shift
                                                        setSelectedMultiShiftId(null);
                                                        setSelectedShiftIds(prev =>
                                                            prev.includes(s.shiftId)
                                                                ? prev.filter(id => id !== s.shiftId)
                                                                : [...prev, s.shiftId]
                                                        );
                                                    }
                                                }}
                                                onSelectSeat={(seatId) => { markTouched("allocation"); setSelectedSeatId(seatId); }}
                                            />
                                            <FieldError id="add-student-allocation-error" error={allocationError} />

                                            {feeLinkLabel && (
                                                <label className={cn("group mt-4 flex w-max cursor-pointer items-center gap-3 px-4 py-3", formSurfaceClass)}>
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
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </form>
        </Dialog>
    );
}
