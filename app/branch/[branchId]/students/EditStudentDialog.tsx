"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Loader2, AlertCircle, User, Phone, IndianRupee } from "lucide-react";
import type { Student } from "@/app/generated/prisma/browser";
import { FORM_LIMITS, parseIntegerField, validateRequiredPhone, validateRequiredText } from "@/lib/formValidation";
import {
    formCompactLabelClass,
    formControlClass,
    formErrorBannerClass,
    formHelpTextClass,
    formIconClass,
} from "@/components/ui/formSurface";
import { FieldError, fieldErrorClass, fieldErrorProps, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { cn } from "@/lib/utils";

interface EditStudentDialogProps {
    isOpen: boolean;
    student: Student | null;
    branchId: string;
    onClose: () => void;
    onSuccess: (updated: Student) => void;
}

export function EditStudentDialog({
    isOpen,
    student,
    branchId,
    onClose,
    onSuccess,
}: EditStudentDialogProps) {
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [monthlyFee, setMonthlyFee] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<"name" | "phone" | "monthlyFee">();

    // Sync form when student changes
    useEffect(() => {
        if (student) {
            setName(student.name ?? "");
            setPhone(student.phone ?? "");
            setMonthlyFee(student.monthlyFee != null ? String(student.monthlyFee) : "");
            setError(null);
            resetFieldErrors();
        }
    }, [resetFieldErrors, student]);

    if (!isOpen || !student) return null;

    const currentFeeStr = student.monthlyFee != null ? String(student.monthlyFee) : "";
    const linkedFeeSource = student.feeLinkedMultiShiftId
        ? "multi-shift price"
        : student.feeLinkedShiftId
            ? "shift price"
            : null;
    const hasChanges =
        name.trim() !== (student.name ?? "") ||
        phone.trim() !== (student.phone ?? "") ||
        monthlyFee !== currentFeeStr;

    const validateForm = () => {
        const errors: Partial<Record<"name" | "phone" | "monthlyFee", string>> = {};
        const nameResult = validateRequiredText(name, "Student name");
        const phoneResult = validateRequiredPhone(phone);
        const monthlyFeeResult = monthlyFee !== currentFeeStr && monthlyFee.trim() !== ""
            ? parseIntegerField(monthlyFee, "Monthly fee", { min: 0, max: FORM_LIMITS.moneyMax })
            : null;

        if (!nameResult.ok) errors.name = nameResult.error;
        if (!phoneResult.ok) errors.phone = phoneResult.error;
        if (monthlyFeeResult && !monthlyFeeResult.ok) errors.monthlyFee = monthlyFeeResult.error;

        if (!nameResult.ok || !phoneResult.ok || (monthlyFeeResult && !monthlyFeeResult.ok)) {
            return { errors, values: null };
        }

        return { errors, values: { nameResult, phoneResult, monthlyFeeResult } };
    };

    const validation = validateForm();
    const nameError = visibleError("name", validation.errors);
    const phoneError = visibleError("phone", validation.errors);
    const monthlyFeeError = visibleError("monthlyFee", validation.errors);

    const handleSave = async () => {
        markSubmitted();
        setError(null);
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean) || !result.values) {
            return;
        }
        const { nameResult, phoneResult, monthlyFeeResult } = result.values;
        setLoading(true);
        try {
            const res = await fetch(`/api/branches/${branchId}/students`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: student.id,
                    name: nameResult.value,
                    phone: phoneResult.value,
                    ...(monthlyFeeResult?.ok && monthlyFeeResult.value !== undefined ? { monthlyFee: monthlyFeeResult.value } : {}),
                }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || "Failed to update");
            }
            const updated = await res.json();
            onSuccess(updated);
            onClose();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Something went wrong.");
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        if (loading) return;
        setError(null);
        resetFieldErrors();
        onClose();
    };

    return (
        <Dialog
            open={isOpen}
            onClose={handleClose}
            title="Edit student"
            description="Update profile details."
            closeLabel="Close edit student dialog"
            closeDisabled={loading}
            className="max-w-sm"
            footer={(
                <>
                    <Button variant="ghost" onClick={handleClose} disabled={loading} className="h-11 px-3 text-sm lg:h-8">
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSave}
                        disabled={loading || !hasChanges}
                        className="h-11 min-w-[90px] justify-center px-4 text-sm lg:h-8"
                    >
                        {loading
                            ? <><Loader2 size={12} className="mr-1.5 animate-spin" aria-hidden="true" /> Saving...</>
                            : "Save Changes"
                        }
                    </Button>
                </>
            )}
        >
                <div className="space-y-4" aria-describedby={error ? "edit-student-submit-error" : undefined}>
                    {/* Name */}
                    <div className="space-y-1.5">
                        <label htmlFor="edit-student-name" className={formCompactLabelClass}>Full Name *</label>
                        <div className="relative">
                            <User size={14} className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} aria-hidden="true" />
                            <input
                                id="edit-student-name"
                                type="text"
                                value={name}
                                onChange={e => { setName(e.target.value); setError(null); }}
                                onBlur={() => markTouched("name")}
                                placeholder="Student's full name"
                                data-dialog-initial-focus
                                maxLength={FORM_LIMITS.nameMax}
                                className={cn(formControlClass, "py-2.5 pl-9 pr-4 text-sm", fieldErrorClass(nameError))}
                                {...fieldErrorProps("edit-student-name-error", nameError)}
                            />
                        </div>
                        <FieldError id="edit-student-name-error" error={nameError} />
                    </div>

                    {/* Phone */}
                    <div className="space-y-1.5">
                        <label htmlFor="edit-student-phone" className={formCompactLabelClass}>Phone Number *</label>
                        <div className="relative">
                            <Phone size={14} className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} aria-hidden="true" />
                            <input
                                id="edit-student-phone"
                                type="tel"
                                value={phone}
                                onChange={e => { setPhone(e.target.value); setError(null); }}
                                onBlur={() => markTouched("phone")}
                                placeholder="e.g. 9876543210"
                                inputMode="tel"
                                maxLength={24}
                                className={cn(formControlClass, "py-2.5 pl-9 pr-4 text-sm", fieldErrorClass(phoneError))}
                                {...fieldErrorProps("edit-student-phone-error", phoneError)}
                            />
                        </div>
                        <FieldError id="edit-student-phone-error" error={phoneError} />
                    </div>

                    {/* Monthly Fee */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                            <label htmlFor="edit-student-monthly-fee" className={formCompactLabelClass}>Monthly Fee</label>
                            {linkedFeeSource && (
                                <span className="rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[color:var(--ui-badge-cyan-text)]">
                                    Linked
                                </span>
                            )}
                        </div>
                        <div className="relative">
                            <IndianRupee size={14} className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} aria-hidden="true" />
                            <input
                                id="edit-student-monthly-fee"
                                type="number"
                                min={0}
                                max={FORM_LIMITS.moneyMax}
                                step={1}
                                inputMode="numeric"
                                value={monthlyFee}
                                onChange={e => { setMonthlyFee(e.target.value); setError(null); }}
                                onBlur={() => markTouched("monthlyFee")}
                                placeholder="e.g. 1500"
                                className={cn(formControlClass, "py-2.5 pl-9 pr-4 text-sm", fieldErrorClass(monthlyFeeError))}
                                {...fieldErrorProps("edit-student-monthly-fee-error", monthlyFeeError)}
                                aria-describedby={[
                                    monthlyFeeError ? "edit-student-monthly-fee-error" : null,
                                    linkedFeeSource ? "edit-student-monthly-fee-help" : null,
                                ].filter(Boolean).join(" ") || undefined}
                            />
                        </div>
                        <FieldError id="edit-student-monthly-fee-error" error={monthlyFeeError} />
                        {linkedFeeSource && (
                            <p id="edit-student-monthly-fee-help" className={cn("text-[11px] leading-relaxed", formHelpTextClass)}>
                                Currently linked to {linkedFeeSource}. Editing this amount will switch the student to a manual fee.
                            </p>
                        )}
                    </div>

                    {error && (
                        <div id="edit-student-submit-error" role="alert" className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                            <AlertCircle size={13} aria-hidden="true" /> {error}
                        </div>
                    )}
                </div>
        </Dialog>
    );
}
