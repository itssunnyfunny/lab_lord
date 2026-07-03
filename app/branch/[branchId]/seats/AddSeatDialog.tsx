"use client";

import { useEffect, useState } from "react";
import { Hash, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
    SeatNumberingBuilder,
    createRangeSeatNumbering,
} from "@/components/seats/SeatNumberingBuilder";
import {
    formControlClass,
    formDialogFooterClass,
    formDialogHeaderClass,
    formDialogPanelClass,
    formErrorBannerClass,
    formHelpTextClass,
    formLabelClass,
    formRequiredClass,
} from "@/components/ui/formSurface";
import { FieldError, fieldErrorClass, fieldErrorProps, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { branches } from "@/lib/api/branches";
import { FORM_LIMITS, validateSeatLabel } from "@/lib/formValidation";
import { generateSeatLabels, type SeatNumberingConfig } from "@/lib/seatNumbering";
import { cn } from "@/lib/utils";

interface AddSeatDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    branchId: string;
}

function getErrorMessage(err: unknown) {
    const response = (err as { response?: { data?: { error?: unknown; message?: unknown } } }).response;
    if (typeof response?.data?.error === "string") return response.data.error;
    if (typeof response?.data?.message === "string") return response.data.message;
    if (err instanceof Error) return err.message;
    return "Failed to create seat.";
}

export function AddSeatDialog({ isOpen, onClose, onSuccess, branchId }: AddSeatDialogProps) {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [label, setLabel] = useState("");
    const [mode, setMode] = useState<"single" | "generate">("single");
    const [seatNumbering, setSeatNumbering] = useState<SeatNumberingConfig>(createRangeSeatNumbering());
    const { markTouched, markSubmitted, resetFieldErrors, visibleError } = useInlineFieldErrors<"label" | "seatNumbering">();

    useEffect(() => {
        if (!isOpen) {
            setError(null);
            setLabel("");
            setMode("single");
            setSeatNumbering(createRangeSeatNumbering());
            resetFieldErrors();
        }
    }, [isOpen, resetFieldErrors]);

    if (!isOpen) return null;

    const validateForm = () => {
        const errors: Partial<Record<"label" | "seatNumbering", string>> = {};
        const labelResult = mode === "single"
            ? validateSeatLabel(label)
            : { ok: true as const, value: "" };
        const seatNumberingResult = mode === "generate"
            ? generateSeatLabels(seatNumbering)
            : { ok: true as const, value: [] };

        if (!labelResult.ok) errors.label = labelResult.error;
        if (!seatNumberingResult.ok) errors.seatNumbering = seatNumberingResult.error;
        if (seatNumberingResult.ok && mode === "generate" && seatNumberingResult.value.length === 0) {
            errors.seatNumbering = "Seat numbering must create at least one seat.";
        }
        return { errors, labelResult, seatNumberingResult };
    };
    const validation = validateForm();
    const labelError = visibleError("label", validation.errors);
    const seatNumberingError = visibleError("seatNumbering", validation.errors);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        markSubmitted();
        setError(null);

        const { errors, labelResult } = validateForm();
        if (Object.values(errors).some(Boolean) || !labelResult.ok) {
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            if (mode === "single") {
                await branches.createSeat(branchId, labelResult.value);
            } else {
                await branches.generateSeats(branchId, seatNumbering);
            }
            onSuccess();
            onClose();
        } catch (err: unknown) {
            setError(getErrorMessage(err));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-[color:var(--ui-form-overlay-bg)] p-3 backdrop-blur-sm animate-in fade-in duration-200 sm:items-center sm:p-4">
            <div
                className={cn("flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col animate-in zoom-in-95 duration-200", formDialogPanelClass)}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={cn("flex flex-shrink-0 items-center justify-between px-4 py-4 sm:px-6", formDialogHeaderClass)}>
                    <h2 className="text-lg font-semibold text-[color:var(--ui-dialog-title)]">Add Seats</h2>
                    <button type="button" onClick={onClose} className={cn("cursor-pointer transition-colors hover:text-[color:var(--ui-table-text)]", formHelpTextClass)}>
                        <X size={20} />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                    <form id="add-seat-form" onSubmit={handleSubmit} className="space-y-6">
                        {error && (
                            <div className={cn("p-3 text-sm", formErrorBannerClass)}>
                                {error}
                            </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => { setMode("single"); resetFieldErrors(); setError(null); }}
                                className={cn(
                                    "inline-flex items-center gap-2 rounded-[var(--ui-radius-control)] border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                                    mode === "single"
                                        ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                                        : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] text-[color:var(--ui-form-help)] hover:border-[color:var(--ui-form-input-border)]"
                                )}
                                aria-pressed={mode === "single"}
                            >
                                <Plus size={15} />
                                Single seat
                            </button>
                            <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => { setMode("generate"); resetFieldErrors(); setError(null); }}
                                className={cn(
                                    "inline-flex items-center gap-2 rounded-[var(--ui-radius-control)] border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                                    mode === "generate"
                                        ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                                        : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] text-[color:var(--ui-form-help)] hover:border-[color:var(--ui-form-input-border)]"
                                )}
                                aria-pressed={mode === "generate"}
                            >
                                <Hash size={15} />
                                Generate seats
                            </button>
                        </div>

                        {mode === "single" ? (
                            <div className="space-y-2">
                                <label htmlFor="label" className={formLabelClass}>
                                    Seat Label <span className={formRequiredClass}>*</span>
                                </label>
                                <input
                                    id="label"
                                    type="text"
                                    disabled={isLoading}
                                    value={label}
                                    onChange={(e) => { setLabel(e.target.value); setError(null); }}
                                    onBlur={() => markTouched("label")}
                                    className={cn(formControlClass, "px-3 py-2", fieldErrorClass(labelError))}
                                    placeholder="e.g. S-01, Row A - 12"
                                    autoFocus
                                    maxLength={FORM_LIMITS.seatLabelMax}
                                    {...fieldErrorProps("add-seat-label-error", labelError)}
                                />
                                <FieldError id="add-seat-label-error" error={labelError} />
                                <p className={cn("text-xs", formHelpTextClass)}>
                                    Provide a unique identifier for this seat to distinguish it in the study hall.
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <label className={formLabelClass}>
                                    Seat numbering <span className={formRequiredClass}>*</span>
                                </label>
                                <SeatNumberingBuilder
                                    value={seatNumbering}
                                    onChange={(next) => {
                                        markTouched("seatNumbering");
                                        setSeatNumbering(next);
                                        setError(null);
                                    }}
                                    disabled={isLoading}
                                />
                                <FieldError id="generate-seat-numbering-error" error={seatNumberingError} />
                            </div>
                        )}
                    </form>
                </div>

                <div className={cn("flex flex-shrink-0 flex-col-reverse gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6", formDialogFooterClass)}>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={isLoading}>
                        Cancel
                    </Button>
                    <Button type="submit" form="add-seat-form" disabled={isLoading} className="min-w-[120px]">
                        {isLoading ? (
                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</>
                        ) : (
                            mode === "single" ? "Create Seat" : "Generate Seats"
                        )}
                    </Button>
                </div>
            </div>
        </div>
    );
}
