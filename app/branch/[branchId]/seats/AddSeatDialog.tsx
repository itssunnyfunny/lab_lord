"use client";

import { useEffect, useState } from "react";
import { Hash, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import {
    SeatNumberingBuilder,
    createRangeSeatNumbering,
} from "@/components/seats/SeatNumberingBuilder";
import {
    formControlClass,
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
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="Add seats"
            description="Create one seat or generate a numbered set."
            closeLabel="Close add seats dialog"
            closeDisabled={isLoading}
            className="max-w-md"
            footer={(
                <>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={isLoading}>
                        Cancel
                    </Button>
                    <Button type="submit" form="add-seat-form" disabled={isLoading} className="min-w-[120px]">
                        {isLoading ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Saving...</>
                        ) : (
                            mode === "single" ? "Create Seat" : "Generate Seats"
                        )}
                    </Button>
                </>
            )}
        >
                    <form
                        id="add-seat-form"
                        onSubmit={handleSubmit}
                        aria-describedby={error ? "add-seat-submit-error" : undefined}
                        noValidate
                        className="space-y-6"
                    >
                        {error && (
                            <div id="add-seat-submit-error" role="alert" className={cn("p-3 text-sm", formErrorBannerClass)}>
                                {error}
                            </div>
                        )}

                        <div className="flex flex-wrap gap-2" role="group" aria-label="Seat creation mode">
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
                                <Plus size={15} aria-hidden="true" />
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
                                <Hash size={15} aria-hidden="true" />
                                Generate seats
                            </button>
                        </div>

                        {mode === "single" ? (
                            <div className="space-y-2">
                                <label htmlFor="add-seat-label" className={formLabelClass}>
                                    Seat Label <span className={formRequiredClass}>*</span>
                                </label>
                                <input
                                    id="add-seat-label"
                                    type="text"
                                    disabled={isLoading}
                                    value={label}
                                    onChange={(e) => { setLabel(e.target.value); setError(null); }}
                                    onBlur={() => markTouched("label")}
                                    className={cn(formControlClass, "px-3 py-2", fieldErrorClass(labelError))}
                                    placeholder="e.g. S-01, Row A - 12"
                                    data-dialog-initial-focus
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
                                <div
                                    role="group"
                                    aria-labelledby="generate-seat-numbering-label"
                                    aria-describedby={seatNumberingError ? "generate-seat-numbering-error" : undefined}
                                >
                                <p id="generate-seat-numbering-label" className={formLabelClass}>
                                    Seat numbering <span className={formRequiredClass}>*</span>
                                </p>
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
                            </div>
                        )}
                    </form>
        </Dialog>
    );
}
