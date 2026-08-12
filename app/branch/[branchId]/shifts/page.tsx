"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { AppButton, AppSelect, Dialog, PageLoadingSkeleton, PageShell, useToast } from "@/components/ui";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RowActionsMenu, type RowActionsMenuItem } from "@/components/ui/RowActionsMenu";
import {
    formCompactLabelClass,
    formControlClass,
    formErrorBannerClass,
    formHelpTextClass,
    formIconClass,
    formSurfaceClass,
    formWarningActionClass,
    formWarningBannerClass,
} from "@/components/ui/formSurface";
import {
    pageDescriptionClass,
    pageEmptyStateClass,
    pageEyebrowClass,
    pageErrorIconClass,
    pageErrorStateClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetHoverClass,
    pageInsetMetricClass,
    pageInsetSurfaceClass,
    pageMetaPillClass,
    pageMutedTextClass,
    pageSubtleTextClass,
    pageTableBodyDividerClass,
    pageTableHeadClass,
    pageTableRowClass,
    pageTableShellClass,
    pageTitleClass,
} from "@/components/ui/pageSurface";
import { FieldError, fieldErrorClass, fieldErrorProps, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import {
    Pencil, Trash2,
    Loader2, AlertCircle, Clock, IndianRupee,
    CheckCircle2, AlertTriangle,
    Users, ArrowRight, RefreshCw, Ban, Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseNullableTime, timesOverlap } from "@/utils/shiftTime";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalTime,
    validateRequiredText,
} from "@/lib/formValidation";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { getPermissionHelpText } from "@/lib/permissionMessages";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import type { CapabilityDecision } from "@/types";

function formatMins(mins: number) {
    let raw = mins;
    if (raw < 0) raw += 1440;
    raw = raw % 1440;
    const h = Math.floor(raw / 60);
    const m = raw % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Shift {
    id: string;
    name: string;
    startTime: string | null;
    endTime: string | null;
    isReserved: boolean;
    price: number;
}

interface MultiShift {
    id: string;
    name: string;
    price: number;
    components: {
        shiftId: string;
        shiftName: string;
        startTime: string | null;
        endTime: string | null;
        order: number;
    }[];
}

interface ShiftAllocation {
    allocationId: string;
    studentId: string;
    studentName: string;
    seatLabel: string;
}

interface OtherShift {
    shiftId: string;
    name: string;
    totalSeats: number;
    activeAllocations: number;
    emptySeats: number;
}

interface ShiftImpactAnalysis {
    studentsInShift: number;
    allocations: ShiftAllocation[];
    otherShifts: OtherShift[];
    totalEmptyElsewhere: number;
    shiftsWithEnoughCapacity: string[];
    willOverflowBy: number;
    isLastActiveShift: boolean;
}

// ─── Add/Edit Dialog ────────────────────────────────────────────────────────────

type DeleteResolution =
    | { type: "END_ALL" }
    | { type: "REALLOCATE_BULK"; targetShiftId: string }
    | { type: "REALLOCATE_MANUAL"; assignments: { allocationId: string; targetShiftId: string }[] };

function getErrorMessage(err: unknown, fallback = "Something went wrong.") {
    return err instanceof Error ? err.message : fallback;
}

interface ShiftDialogProps {
    isOpen: boolean;
    mode: "add" | "edit";
    initial?: Shift;
    branchId: string;
    existingShifts: Shift[];
    onClose: () => void;
    onSuccess: (shift: Shift) => void;
}

function ShiftDialog({ isOpen, mode, initial, branchId, existingShifts, onClose, onSuccess }: ShiftDialogProps) {
    const [name, setName] = useState("");
    const [startTime, setStartTime] = useState("");
    const [endTime, setEndTime] = useState("");
    const [price, setPrice] = useState("0");
    const [isReserved, setIsReserved] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Only activate the overlap guard when the user has actually touched a time
    // field in this session (or when adding a brand-new shift).
    const [timesTouched, setTimesTouched] = useState(false);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<"name" | "startTime" | "endTime" | "timePair" | "price" | "overlap">();

    useEffect(() => {
        if (isOpen) {
            setName(initial?.name ?? "");
            setStartTime(initial?.startTime ?? "");
            setEndTime(initial?.endTime ?? "");
            setPrice(String(initial?.price ?? 0));
            setIsReserved(initial?.isReserved ?? false);
            setError(null);
            setTimesTouched(false); // reset every time the dialog opens
            resetFieldErrors();
        }
    }, [isOpen, initial, resetFieldErrors]);

    // In "add" mode we always check (no saved times to defer from).
    // In "edit" mode we only check after the user touches a time input.
    const shouldCheckOverlap = mode === "add" || timesTouched;

    const overlapWith = shouldCheckOverlap
        ? existingShifts.find(s => {
            if (s.id === initial?.id) return false;
            if (!s.startTime || !s.endTime || !startTime || !endTime) return false;
            const start1 = parseNullableTime(startTime);
            const end1 = parseNullableTime(endTime);
            const start2 = parseNullableTime(s.startTime);
            const end2 = parseNullableTime(s.endTime);
            return timesOverlap(start1, end1, start2, end2);
        })
        : null;

    if (!isOpen) return null;

    const validateForm = () => {
        const errors: Partial<Record<"name" | "startTime" | "endTime" | "timePair" | "price" | "overlap", string>> = {};
        const nameResult = validateRequiredText(name, "Shift name", 50);
        const startResult = validateOptionalTime(startTime, "Start time");
        const endResult = validateOptionalTime(endTime, "End time");
        const priceResult = parseIntegerField(price, "Monthly price", { min: 0, max: FORM_LIMITS.moneyMax });
        if (!nameResult.ok) errors.name = nameResult.error;
        if (!startResult.ok) errors.startTime = startResult.error;
        if (!endResult.ok) errors.endTime = endResult.error;
        const startValue = startResult.ok ? startResult.value : null;
        const endValue = endResult.ok ? endResult.value : null;
        if ((startValue && !endValue) || (!startValue && endValue)) {
            errors.timePair = "Shift must have both start and end time, or neither.";
        }
        if (!priceResult.ok) errors.price = priceResult.error;
        if (overlapWith) errors.overlap = "Resolve the shift time overlap.";
        if (!nameResult.ok || !startResult.ok || !endResult.ok || !!errors.timePair || !priceResult.ok || !!overlapWith) {
            return { errors, values: null };
        }
        return { errors, values: { nameResult, startResult, endResult, priceResult } };
    };

    const validation = validateForm();
    const nameError = visibleError("name", validation.errors);
    const startTimeError = visibleError("startTime", validation.errors);
    const endTimeError = visibleError("endTime", validation.errors);
    const timePairError = visibleError("timePair", validation.errors);
    const priceError = visibleError("price", validation.errors);
    const overlapError = visibleError("overlap", validation.errors);
    const timeGroupError = startTimeError || endTimeError || timePairError || overlapError;

    const handleSubmit = async () => {
        markSubmitted();
        setError(null);
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean) || !result.values) return;
        const { nameResult, startResult, endResult, priceResult } = result.values;
        setLoading(true);
        try {
            const url = mode === "edit" && initial
                ? `/api/branches/${branchId}/shifts/${initial.id}`
                : `/api/branches/${branchId}/shifts`;
            const method = mode === "edit" ? "PATCH" : "POST";
            const payload: {
                name: string;
                price: number;
                isReserved: boolean;
                startTime?: string | null;
                endTime?: string | null;
            } = {
                name: nameResult.value,
                price: priceResult.value ?? 0,
                isReserved,
            };

            if (mode === "add" || timesTouched) {
                payload.startTime = startResult.value;
                payload.endTime = endResult.value;
            }

            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || "Operation failed");
            }
            const saved = await res.json();
            onSuccess(saved);
            onClose();
        } catch (err: unknown) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title={mode === "add" ? "Add shift" : "Edit shift"}
            description={mode === "add" ? "Create a new time window." : "Update this shift's details."}
            closeDisabled={loading}
            className="max-w-sm"
            footer={(
                <>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={loading} className="h-11 px-4 text-sm">
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={handleSubmit}
                        disabled={loading}
                        className="h-11 min-w-[100px] justify-center px-4 text-sm"
                    >
                        {loading
                            ? <><Loader2 size={12} className="mr-1.5 animate-spin" aria-hidden="true" /> {mode === "add" ? "Adding..." : "Saving..."}</>
                            : mode === "add" ? "Add shift" : "Save changes"
                        }
                    </Button>
                </>
            )}
        >
                <div className="space-y-4" aria-describedby={error ? "shift-submit-error" : undefined}>
                    <div className="space-y-1.5">
                        <label htmlFor="shift-name" className={formCompactLabelClass}>Shift name *</label>
                        <input
                            id="shift-name"
                            type="text"
                            value={name}
                            onChange={e => { setName(e.target.value); setError(null); }}
                            onBlur={() => markTouched("name")}
                            placeholder="e.g. Morning, Afternoon"
                            data-dialog-initial-focus
                            className={cn(formControlClass, "px-4 py-2.5 text-sm", fieldErrorClass(nameError))}
                            {...fieldErrorProps("shift-name-error", nameError)}
                        />
                        <FieldError id="shift-name-error" error={nameError} />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <label htmlFor="shift-start-time" className={formCompactLabelClass}>Start time</label>
                            <input
                                id="shift-start-time"
                                type="time"
                                value={startTime}
                                onChange={e => { setStartTime(e.target.value); setTimesTouched(true); setError(null); markTouched("timePair"); markTouched("overlap"); }}
                                onBlur={() => markTouched("startTime")}
                                className={cn(formControlClass, "px-3 py-2.5 text-sm", fieldErrorClass(startTimeError || timePairError || overlapError))}
                                {...fieldErrorProps("shift-time-error", timeGroupError)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label htmlFor="shift-end-time" className={formCompactLabelClass}>End time</label>
                            <input
                                id="shift-end-time"
                                type="time"
                                value={endTime}
                                onChange={e => { setEndTime(e.target.value); setTimesTouched(true); setError(null); markTouched("timePair"); markTouched("overlap"); }}
                                onBlur={() => markTouched("endTime")}
                                className={cn(formControlClass, "px-3 py-2.5 text-sm", fieldErrorClass(endTimeError || timePairError || overlapError))}
                                {...fieldErrorProps("shift-time-error", timeGroupError)}
                            />
                        </div>
                    </div>
                    <FieldError id="shift-time-error" error={timeGroupError} />

                    <div className="space-y-1.5">
                        <label htmlFor="shift-price" className={formCompactLabelClass}>Monthly price</label>
                        <div className="relative">
                            <IndianRupee size={13} className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} aria-hidden="true" />
                            <input
                                id="shift-price"
                                type="number"
                                value={price}
                                onChange={e => { setPrice(e.target.value); setError(null); }}
                                onBlur={() => markTouched("price")}
                                min="0"
                                max={FORM_LIMITS.moneyMax}
                                step="1"
                                inputMode="numeric"
                                placeholder="0"
                                className={cn(formControlClass, "py-2.5 pl-8 pr-4 text-sm", fieldErrorClass(priceError))}
                                {...fieldErrorProps("shift-price-error", priceError)}
                            />
                        </div>
                        <FieldError id="shift-price-error" error={priceError} />
                    </div>

                    {/* Reserved toggle */}
                    <div className="flex items-center justify-between py-1">
                        <div>
                            <p id="shift-reserved-label" className="text-sm font-medium text-[color:var(--text-primary)]">Reserved shift</p>
                            <p id="shift-reserved-help" className={cn("text-xs", formHelpTextClass)}>Seats in this shift require manual allocation</p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={isReserved}
                            aria-labelledby="shift-reserved-label"
                            aria-describedby="shift-reserved-help"
                            onClick={() => setIsReserved(v => !v)}
                            className={cn(
                                "w-10 h-5 rounded-full relative transition-colors",
                                isReserved ? "bg-[color:var(--ui-form-toggle-checked-bg)]" : "bg-[color:var(--ui-form-toggle-bg)]"
                            )}
                        >
                            <div className={cn(
                                "absolute top-0.5 h-4 w-4 rounded-full bg-[color:var(--ui-form-toggle-thumb)] shadow-sm transition-transform",
                                isReserved ? "translate-x-5" : "translate-x-0.5"
                            )} />
                        </button>
                    </div>

                    {error && (
                        <div id="shift-submit-error" role="alert" className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                            <AlertCircle size={13} aria-hidden="true" /> {error}
                        </div>
                    )}

                    {overlapWith && (
                        <div role="alert" className={cn("mt-2 flex flex-col gap-1.5 px-3 py-2 text-xs", formWarningBannerClass)}>
                            <div className="flex items-center gap-1.5">
                                <AlertTriangle size={13} aria-hidden="true" />
                                <span>Time overlaps with &ldquo;{overlapWith.name}&rdquo; ({overlapWith.startTime} - {overlapWith.endTime}).</span>
                            </div>
                            <div className="flex flex-col gap-1 mt-1">
                                <button type="button" onClick={() => setEndTime(formatMins(parseNullableTime(overlapWith.startTime)! - 1))} className={cn("px-2 py-1.5 text-left", formWarningActionClass)}>
                                    Set End Time to {formatMins(parseNullableTime(overlapWith.startTime)! - 1)}
                                </button>
                                <button type="button" onClick={() => setStartTime(formatMins(parseNullableTime(overlapWith.endTime)! + 1))} className={cn("px-2 py-1.5 text-left", formWarningActionClass)}>
                                    Set Start Time to {formatMins(parseNullableTime(overlapWith.endTime)! + 1)}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
        </Dialog>
    );
}

// ─── Delete Shift Dialog ────────────────────────────────────────────────────────

type ResolutionMode = "END_ALL" | "REALLOCATE_BULK" | "REALLOCATE_MANUAL" | "RENAME";

interface DeleteShiftDialogProps {
    shift: Shift;
    branchId: string;
    existingShifts: Shift[];
    onClose: () => void;
    onDeleted: (shiftId: string) => void;
    onRenamed: (shift: Shift) => void;
}

function DeleteShiftDialog({ shift, branchId, existingShifts, onClose, onDeleted, onRenamed }: DeleteShiftDialogProps) {
    const [step, setStep] = useState<"loading" | "blocked" | "confirm-empty" | "resolve">("loading");
    const [analysis, setAnalysis] = useState<ShiftImpactAnalysis | null>(null);
    const [analyzeError, setAnalyzeError] = useState<string | null>(null);

    // Resolution state
    const [mode, setMode] = useState<ResolutionMode>("END_ALL");
    const [bulkTargetId, setBulkTargetId] = useState("");
    const [manualAssignments, setManualAssignments] = useState<Record<string, string>>({}); // allocationId → targetShiftId

    // Rename state
    const [renameName, setRenameName] = useState(shift.name);
    const [renameStart, setRenameStart] = useState(shift.startTime ?? "");
    const [renameEnd, setRenameEnd] = useState(shift.endTime ?? "");

    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<"renameName" | "renameStart" | "renameEnd" | "renameTimePair" | "renameOverlap">();

    // Load analysis on mount
    useEffect(() => {
        resetFieldErrors();
        const run = async () => {
            try {
                const res = await fetch(`/api/branches/${branchId}/shifts/${shift.id}/analyze`);
                if (!res.ok) {
                    const d = await res.json().catch(() => ({}));
                    throw new Error(d.error || "Failed to analyze shift.");
                }
                const data: ShiftImpactAnalysis = await res.json();
                setAnalysis(data);

                if (data.isLastActiveShift) { setStep("blocked"); return; }
                if (data.studentsInShift === 0) { setStep("confirm-empty"); return; }
                setStep("resolve");

                // Pre-select bulk target if one shift has enough capacity
                if (data.shiftsWithEnoughCapacity.length > 0) {
                    setMode("REALLOCATE_BULK");
                    setBulkTargetId(data.shiftsWithEnoughCapacity[0]);
                } else {
                    setMode("END_ALL");
                }
            } catch (e: unknown) {
                setAnalyzeError(getErrorMessage(e, "Could not load shift analysis."));
                setStep("resolve"); // fallback to END_ALL only
            }
        };
        run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleDelete = async () => {
        setSubmitting(true);
        setSubmitError(null);
        try {
            let resolution: DeleteResolution | undefined;
            if (mode === "END_ALL") {
                resolution = { type: "END_ALL" };
            } else if (mode === "REALLOCATE_BULK") {
                if (!bulkTargetId) throw new Error("Please select a target shift.");
                resolution = { type: "REALLOCATE_BULK", targetShiftId: bulkTargetId };
            } else if (mode === "REALLOCATE_MANUAL") {
                const assignments = analysis?.allocations.map(a => ({
                    allocationId: a.allocationId,
                    targetShiftId: manualAssignments[a.allocationId] ?? "",
                })) ?? [];
                if (assignments.some(a => !a.targetShiftId)) throw new Error("Assign a shift for every student.");
                resolution = { type: "REALLOCATE_MANUAL", assignments };
            }

            const res = await fetch(`/api/branches/${branchId}/shifts/${shift.id}`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ resolution }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || "Delete failed.");
            }
            onDeleted(shift.id);
            onClose();
        } catch (e: unknown) {
            setSubmitError(getErrorMessage(e));
        } finally {
            setSubmitting(false);
        }
    };

    const getRenameOverlap = () => existingShifts.find(s => {
        if (s.id === shift.id) return false;
        if (!s.startTime || !s.endTime || !renameStart || !renameEnd) return false;
        if (s.name.toLowerCase() === "full time" || renameName.trim().toLowerCase() === "full time") return false;
        return timesOverlap(
            parseNullableTime(renameStart),
            parseNullableTime(renameEnd),
            parseNullableTime(s.startTime),
            parseNullableTime(s.endTime)
        );
    });

    const validateRenameForm = () => {
        const errors: Partial<Record<"renameName" | "renameStart" | "renameEnd" | "renameTimePair" | "renameOverlap", string>> = {};
        const nameResult = validateRequiredText(renameName, "Shift name", 50);
        const startResult = validateOptionalTime(renameStart, "Start time");
        const endResult = validateOptionalTime(renameEnd, "End time");
        const startValue = startResult.ok ? startResult.value : null;
        const endValue = endResult.ok ? endResult.value : null;
        const renameOverlapWith = getRenameOverlap();

        if (!nameResult.ok) errors.renameName = nameResult.error;
        if (!startResult.ok) errors.renameStart = startResult.error;
        if (!endResult.ok) errors.renameEnd = endResult.error;
        if ((startValue && !endValue) || (!startValue && endValue)) {
            errors.renameTimePair = "Shift must have both start and end time, or neither.";
        }
        if (renameOverlapWith) errors.renameOverlap = `Time overlaps with "${renameOverlapWith.name}".`;

        if (!nameResult.ok || !startResult.ok || !endResult.ok || !!errors.renameTimePair || !!renameOverlapWith) {
            return { errors, values: null };
        }
        return { errors, values: { nameResult, startResult, endResult } };
    };

    const renameValidation = validateRenameForm();
    const renameNameError = visibleError("renameName", renameValidation.errors);
    const renameStartError = visibleError("renameStart", renameValidation.errors);
    const renameEndError = visibleError("renameEnd", renameValidation.errors);
    const renameTimePairError = visibleError("renameTimePair", renameValidation.errors);
    const renameOverlapError = visibleError("renameOverlap", renameValidation.errors);
    const renameTimeGroupError = renameStartError || renameEndError || renameTimePairError || renameOverlapError;

    const handleRename = async () => {
        markSubmitted();
        setSubmitError(null);
        const result = validateRenameForm();
        if (Object.values(result.errors).some(Boolean) || !result.values) return;
        const { nameResult, startResult, endResult } = result.values;
        setSubmitting(true);
        try {
            const res = await fetch(`/api/branches/${branchId}/shifts/${shift.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: nameResult.value,
                    startTime: startResult.value,
                    endTime: endResult.value,
                }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || "Update failed.");
            }
            const updated: Shift = await res.json();
            onRenamed(updated);
            onClose();
        } catch (e: unknown) {
            setSubmitError(getErrorMessage(e));
        } finally {
            setSubmitting(false);
        }
    };

    // ── Check manual assignment validity
    const manualValid = analysis
        ? analysis.allocations.every(a => !!manualAssignments[a.allocationId])
        : false;

    // ── Per-target overflow detection for manual mode
    const manualTargetCounts = Object.values(manualAssignments).reduce<Record<string, number>>((acc, sid) => {
        acc[sid] = (acc[sid] ?? 0) + 1;
        return acc;
    }, {});
    const manualOverflow = analysis
        ? Object.entries(manualTargetCounts).some(([sid, count]) => {
            const t = analysis.otherShifts.find(s => s.shiftId === sid);
            return t ? count > t.emptySeats : false;
        })
        : false;

    return (
        <Dialog
            open
            onClose={onClose}
            title={<>Delete &ldquo;{shift.name}&rdquo;</>}
            description="Review the impact and choose what happens to active allocations before removing this shift."
            icon={<Trash2 size={20} className="text-red-400" />}
            role="alertdialog"
            closeDisabled={submitting}
            className="max-w-lg"
        >

                {/* ── Loading state */}
                {step === "loading" && (
                    <div role="status" aria-live="polite" className="flex flex-col items-center justify-center gap-3 py-16 text-[color:var(--ui-form-label)]">
                        <Loader2 size={28} className="animate-spin text-cyan-500" aria-hidden="true" />
                        <p className="text-sm">Analyzing shift impact...</p>
                    </div>
                )}

                {/* ── Blocked: last active shift */}
                {step === "blocked" && (
                    <div className="p-4 space-y-4 sm:p-6">
                        <div role="alert" className={cn("flex items-start gap-3 p-4", formWarningBannerClass)}>
                            <Ban size={18} className="text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
                            <div>
                                <p className="text-sm font-semibold text-amber-300">Cannot delete this shift</p>
                                <p className="text-xs text-amber-400/80 mt-1">
                                    This is the only active shift in the branch. A branch must have at least one active shift.
                                    Add another shift first, then you can delete this one.
                                </p>
                            </div>
                        </div>
                        <div className="flex justify-end">
                            <Button type="button" onClick={onClose} variant="ghost" className="h-11 px-4 text-sm">Close</Button>
                        </div>
                    </div>
                )}

                {/* ── Confirm empty shift delete */}
                {step === "confirm-empty" && (
                    <div className="p-4 space-y-4 sm:p-6">
                        <p className="text-sm text-[color:var(--ui-form-label)]">
                            This shift has <span className="font-semibold text-[color:var(--text-primary)]">no active students</span>. It will be removed permanently.
                        </p>
                        {submitError && (
                            <div role="alert" className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                                <AlertCircle size={13} aria-hidden="true" /> {submitError}
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting} className="h-11 px-4 text-sm">Cancel</Button>
                            <Button
                                type="button"
                                onClick={handleDelete}
                                disabled={submitting}
                                className="text-sm h-8 px-4 bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30 min-w-[100px] justify-center"
                            >
                                {submitting ? <><Loader2 size={12} className="animate-spin mr-1.5" aria-hidden="true" /> Deleting...</> : "Delete Shift"}
                            </Button>
                        </div>
                    </div>
                )}

                {/* ── Resolution dialog */}
                {step === "resolve" && analysis && (
                    <div className="p-4 space-y-5 sm:p-6">

                        {/* Impact summary */}
                        <div className={cn("space-y-2 p-4", formSurfaceClass)}>
                            <div className="flex items-center gap-2 text-sm">
                                <Users size={14} className="text-cyan-400" />
                                <span className="font-semibold text-[color:var(--text-primary)]">{analysis.studentsInShift} student{analysis.studentsInShift !== 1 ? "s" : ""}</span>
                                <span className={formHelpTextClass}>currently in this shift</span>
                            </div>
                            <div className={cn("flex items-center gap-2 text-xs", formHelpTextClass)}>
                                <ArrowRight size={12} />
                                <span>Empty seats elsewhere: <span className="text-[color:var(--text-primary)]">{analysis.totalEmptyElsewhere}</span></span>
                                {analysis.willOverflowBy > 0 && (
                                    <span className="text-amber-400 flex items-center gap-1">
                                        <AlertTriangle size={11} /> {analysis.willOverflowBy} cannot be reallocated
                                    </span>
                                )}
                            </div>
                        </div>

                        {analyzeError && (
                            <div className={cn("flex items-center gap-2 px-3 py-2 text-sm", formWarningBannerClass)}>
                                <AlertTriangle size={13} /> {analyzeError} — Only &ldquo;End All&rdquo; is available.
                            </div>
                        )}

                        {/* Option cards */}
                        <div className="space-y-2.5">

                            {/* Option A — End All */}
                            <OptionCard
                                selected={mode === "END_ALL"}
                                onClick={() => setMode("END_ALL")}
                                icon={<Ban size={15} className="text-red-400" />}
                                title="End All Allocations"
                                description="All students become unallocated. They remain in the system — only their seat assignment ends."
                                variant="danger"
                            >
                                {mode === "END_ALL" && (
                                    <p className="text-xs text-red-400/80 mt-2 pl-1">
                                        {analysis.studentsInShift} student{analysis.studentsInShift !== 1 ? "s" : ""} will be unallocated.
                                    </p>
                                )}
                            </OptionCard>

                            {/* Option B — Move All to One Shift (only if enough capacity exists in a single shift) */}
                            {analysis.shiftsWithEnoughCapacity.length > 0 && (
                                <OptionCard
                                    selected={mode === "REALLOCATE_BULK"}
                                    onClick={() => { setMode("REALLOCATE_BULK"); if (!bulkTargetId) setBulkTargetId(analysis.shiftsWithEnoughCapacity[0]); }}
                                    icon={<RefreshCw size={15} className="text-emerald-400" />}
                                    title="Move All to One Shift"
                                    description="All students are moved to a single shift in one step."
                                    variant="success"
                                >
                                    {mode === "REALLOCATE_BULK" && (
                                        <div className="mt-3">
                                            <label htmlFor="delete-shift-bulk-target" className={cn("mb-1.5 block text-xs", formHelpTextClass)}>Select target shift</label>
                                            <AppSelect
                                                id="delete-shift-bulk-target"
                                                value={bulkTargetId}
                                                onValueChange={setBulkTargetId}
                                                placeholder="Choose a shift…"
                                                options={analysis.otherShifts
                                                    .filter(s => analysis.shiftsWithEnoughCapacity.includes(s.shiftId))
                                                    .map(s => ({
                                                        value: s.shiftId,
                                                        label: `${s.name} — ${s.emptySeats} empty seat${s.emptySeats !== 1 ? "s" : ""}`,
                                                    }))}
                                            />
                                        </div>
                                    )}
                                </OptionCard>
                            )}

                            {/* Option C — Per-student assignment */}
                            <OptionCard
                                selected={mode === "REALLOCATE_MANUAL"}
                                onClick={() => setMode("REALLOCATE_MANUAL")}
                                icon={<Users size={15} className="text-cyan-400" />}
                                title="Assign Per Student"
                                description="Choose a target shift individually for each student."
                            >
                                {mode === "REALLOCATE_MANUAL" && (
                                    <div className="mt-3 space-y-2">
                                        {analysis.allocations.map(alloc => {
                                            const chosenId = manualAssignments[alloc.allocationId] ?? "";
                                            const chosenShift = analysis.otherShifts.find(s => s.shiftId === chosenId);
                                            const wouldOverflow = chosenShift
                                                ? (manualTargetCounts[chosenId] ?? 0) > chosenShift.emptySeats
                                                : false;
                                            return (
                                                <div key={alloc.allocationId} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                                    <div className="flex-1 min-w-0">
                                                        <p className="truncate text-xs font-medium text-[color:var(--text-primary)]">{alloc.studentName}</p>
                                                        <p className="text-[10px] text-[color:var(--ui-table-subtle)]">Seat {alloc.seatLabel}</p>
                                                    </div>
                                                    <AppSelect
                                                        aria-label={`Target shift for ${alloc.studentName}`}
                                                        value={chosenId}
                                                        onValueChange={value => setManualAssignments(prev => ({
                                                            ...prev,
                                                            [alloc.allocationId]: value,
                                                        }))}
                                                        placeholder="Select shift…"
                                                        options={analysis.otherShifts.map(s => ({
                                                            value: s.shiftId,
                                                            label: `${s.name} (${s.emptySeats} empty)`,
                                                            disabled: s.emptySeats === 0,
                                                        }))}
                                                        containerClassName="w-full sm:min-w-[160px] sm:w-auto"
                                                        className={cn(
                                                            "px-2 py-1.5 text-xs sm:min-w-[160px]",
                                                            wouldOverflow && "border-[color:var(--ui-form-error-border)] focus-visible:border-[color:var(--ui-form-error-focus-border)]"
                                                        )}
                                                    />
                                                </div>
                                            );
                                        })}
                                        {manualOverflow && (
                                            <p role="alert" className="text-xs text-red-400 flex items-center gap-1 mt-1">
                                                <AlertTriangle size={11} aria-hidden="true" /> One or more shifts would overflow. Reassign those students.
                                            </p>
                                        )}
                                    </div>
                                )}
                            </OptionCard>

                            {/* Option D — Rename / Retime Instead */}
                            <OptionCard
                                selected={mode === "RENAME"}
                                onClick={() => setMode("RENAME")}
                                icon={<Pencil size={15} className={pageMutedTextClass} />}
                                title="Rename / Retime Instead"
                                description="Don't delete — just change the name or time window. Students stay allocated."
                            >
                                {mode === "RENAME" && (() => {
                                    const renameOverlapWith = getRenameOverlap();
                                    return (
                                        <div className="mt-3 space-y-3">
                                            <div>
                                                <label htmlFor="rename-shift-name" className={cn("mb-1 block text-xs", formHelpTextClass)}>New name</label>
                                                <input
                                                    id="rename-shift-name"
                                                    type="text"
                                                    value={renameName}
                                                    onChange={e => { setRenameName(e.target.value); setSubmitError(null); }}
                                                    onBlur={() => markTouched("renameName")}
                                                    className={cn(formControlClass, "px-3 py-2 text-sm", fieldErrorClass(renameNameError))}
                                                    {...fieldErrorProps("rename-shift-name-error", renameNameError)}
                                                />
                                                <FieldError id="rename-shift-name-error" error={renameNameError} />
                                            </div>
                                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                                <div>
                                                    <label htmlFor="rename-shift-start-time" className={cn("mb-1 block text-xs", formHelpTextClass)}>Start time</label>
                                                    <input
                                                        id="rename-shift-start-time"
                                                        type="time"
                                                        value={renameStart}
                                                        onChange={e => { setRenameStart(e.target.value); markTouched("renameTimePair"); markTouched("renameOverlap"); }}
                                                        onBlur={() => markTouched("renameStart")}
                                                        className={cn(formControlClass, "px-3 py-2 text-sm", fieldErrorClass(renameStartError || renameTimePairError || renameOverlapError))}
                                                        {...fieldErrorProps("rename-shift-time-error", renameTimeGroupError)}
                                                    />
                                                </div>
                                                <div>
                                                    <label htmlFor="rename-shift-end-time" className={cn("mb-1 block text-xs", formHelpTextClass)}>End time</label>
                                                    <input
                                                        id="rename-shift-end-time"
                                                        type="time"
                                                        value={renameEnd}
                                                        onChange={e => { setRenameEnd(e.target.value); markTouched("renameTimePair"); markTouched("renameOverlap"); }}
                                                        onBlur={() => markTouched("renameEnd")}
                                                        className={cn(formControlClass, "px-3 py-2 text-sm", fieldErrorClass(renameEndError || renameTimePairError || renameOverlapError))}
                                                        {...fieldErrorProps("rename-shift-time-error", renameTimeGroupError)}
                                                    />
                                                </div>
                                            </div>
                                            <FieldError id="rename-shift-time-error" error={renameTimeGroupError} />
                                            {renameOverlapWith && (
                                                <div role="alert" className={cn("flex items-center gap-2 px-3 py-2 text-xs", formWarningBannerClass)}>
                                                    <AlertTriangle size={13} aria-hidden="true" />
                                                    <span>Time overlaps with &ldquo;{renameOverlapWith.name}&rdquo; ({renameOverlapWith.startTime}&nbsp;–&nbsp;{renameOverlapWith.endTime}). Adjust the times before saving.</span>
                                                </div>
                                            )}
                                            {/* Expose overlap state to the footer via a data attribute trick:
                                                We rely on the parent computing this via a sibling IIFE — see footer button below. */}
                                        </div>
                                    );
                                })()}
                            </OptionCard>
                        </div>

                        {/* Submit error */}
                        {submitError && (
                            <div role="alert" className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                                <AlertCircle size={13} aria-hidden="true" /> {submitError}
                            </div>
                        )}

                        {/* Footer actions */}
                        <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
                            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting} className="h-11 px-4 text-sm">
                                Cancel
                            </Button>
                            {mode === "RENAME" ? (
                                <Button
                                    type="button"
                                    onClick={handleRename}
                                    disabled={submitting}
                                    className="text-sm h-8 px-4 min-w-[130px] justify-center"
                                >
                                    {submitting ? <><Loader2 size={12} className="animate-spin mr-1.5" aria-hidden="true" />Saving...</> : "Save Changes"}
                                </Button>
                            ) : (
                                <Button
                                    type="button"
                                    onClick={handleDelete}
                                    disabled={
                                        submitting ||
                                        (mode === "REALLOCATE_BULK" && !bulkTargetId) ||
                                        (mode === "REALLOCATE_MANUAL" && (!manualValid || manualOverflow))
                                    }
                                    className={cn(
                                        "text-sm h-8 px-4 min-w-[130px] justify-center",
                                        "bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30"
                                    )}
                                >
                                    {submitting
                                        ? <><Loader2 size={12} className="animate-spin mr-1.5" aria-hidden="true" />Processing...</>
                                        : mode === "END_ALL" ? "End All & Delete"
                                            : mode === "REALLOCATE_BULK" ? "Move All & Delete"
                                                : "Assign & Delete"
                                    }
                                </Button>
                            )}
                        </div>
                    </div>
                )}
        </Dialog>
    );
}

// ─── Option Card helper ─────────────────────────────────────────────────────────

interface OptionCardProps {
    selected: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    title: string;
    description: string;
    variant?: "danger" | "success";
    children?: React.ReactNode;
}

function OptionCard({ selected, onClick, icon, title, description, variant, children }: OptionCardProps) {
    const selectedSurface = variant === "danger"
        ? "border-red-500/40 bg-red-500/5"
        : variant === "success"
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-cyan-500/40 bg-cyan-500/5";

    return (
        <div
            className={cn(
                "p-4 transition-all",
                selected ? cn("rounded-[var(--ui-radius-control)] border", selectedSurface) : cn(pageInsetSurfaceClass, pageInsetHoverClass)
            )}
        >
            <button
                type="button"
                onClick={onClick}
                aria-pressed={selected}
                className="flex min-h-11 w-full items-start gap-3 rounded-[var(--ui-radius-control)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
            >
                <div className="mt-0.5 shrink-0" aria-hidden="true">{icon}</div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</p>
                    <p className={cn("mt-0.5 text-xs leading-relaxed", pageSubtleTextClass)}>{description}</p>
                </div>
                <span aria-hidden="true" className={cn(
                    "w-4 h-4 rounded-full border shrink-0 mt-0.5 transition-all flex items-center justify-center",
                    selected ? "border-[color:var(--ui-form-accent)] bg-[color:var(--ui-form-accent)]" : "border-[color:var(--ui-form-input-border)]"
                )}>
                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--bg-app)]" />}
                </span>
            </button>
            {children}
        </div>
    );
}

// ─── Row dropdown ──────────────────────────────────────────────────────────────

type RowAction = RowActionsMenuItem;

function RowActions({ actions }: { actions: RowAction[] }) {
    return <RowActionsMenu actions={actions} menuWidthClassName="w-40" />;
}

// ─── Type Picker Dialog ────────────────────────────────────────────────────────

interface TypePickerDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (type: "primary" | "multi") => void;
}

function TypePickerDialog({ isOpen, onClose, onSelect }: TypePickerDialogProps) {
    if (!isOpen) return null;

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="What type of shift?"
            description="Select the kind of allocation window to create."
            className="max-w-md"
        >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
                    <button
                        type="button"
                        onClick={() => onSelect("primary")}
                        data-dialog-initial-focus
                        className={cn("group flex min-h-11 cursor-pointer flex-col items-center gap-3 p-6", pageGridCardClass, pageGridCardHoverClass)}
                    >
                        <div className="flex h-12 w-12 items-center justify-center rounded-[var(--ui-radius-control)] bg-[color:var(--ui-tone-warning-bg)] text-[color:var(--ui-tone-warning-text)] transition-transform group-hover:scale-105">
                            <Clock size={24} aria-hidden="true" />
                        </div>
                        <div className="text-center">
                            <p className="text-sm font-semibold text-[color:var(--text-primary)]">Primary</p>
                            <p className={cn("mt-1 text-[10px] font-semibold uppercase tracking-wider", formHelpTextClass)}>Single Time Slot</p>
                        </div>
                    </button>

                    <button
                        type="button"
                        onClick={() => onSelect("multi")}
                        className={cn("group flex min-h-11 cursor-pointer flex-col items-center gap-3 p-6", pageGridCardClass, pageGridCardHoverClass)}
                    >
                        <div className="flex h-12 w-12 items-center justify-center rounded-[var(--ui-radius-control)] bg-[color:var(--ui-tone-info-bg)] text-[color:var(--ui-tone-info-text)] transition-transform group-hover:scale-105">
                            <Layers size={24} aria-hidden="true" />
                        </div>
                        <div className="text-center">
                            <p className="text-sm font-semibold text-[color:var(--text-primary)]">Multi-shift</p>
                            <p className={cn("mt-1 text-[10px] font-semibold uppercase tracking-wider", formHelpTextClass)}>Bundle of 2+ Primary</p>
                        </div>
                    </button>
                </div>
        </Dialog>
    );
}

// ─── Multi-Shift Dialog ─────────────────────────────────────────────────────────

interface MultiShiftDialogProps {
    isOpen: boolean;
    mode: "add" | "edit";
    initial?: MultiShift;
    branchId: string;
    primaryShifts: Shift[];
    existingMultiShifts: MultiShift[];
    onClose: () => void;
    onSuccess: (ms: MultiShift) => void;
}

function MultiShiftDialog({ isOpen, mode, initial, branchId, primaryShifts, existingMultiShifts, onClose, onSuccess }: MultiShiftDialogProps) {
    const [name, setName] = useState("");
    const [price, setPrice] = useState("0");
    const [selectedShiftIds, setSelectedShiftIds] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<"name" | "price" | "components">();

    useEffect(() => {
        if (isOpen) {
            setName(initial?.name ?? "");
            setPrice(String(initial?.price ?? 0));
            setSelectedShiftIds(initial?.components.map(c => c.shiftId) ?? []);
            setError(null);
            resetFieldErrors();
        }
    }, [isOpen, initial, resetFieldErrors]);

    // Validation
    const selectedSorted = [...selectedShiftIds].sort().join(",");
    const duplicateCombo = existingMultiShifts.find(ms => {
        if (ms.id === initial?.id) return false;
        return [...ms.components].map(c => c.shiftId).sort().join(",") === selectedSorted;
    });

    const duplicateName = existingMultiShifts.find(ms => {
        if (ms.id === initial?.id) return false;
        return ms.name.toLowerCase() === name.trim().toLowerCase();
    });

    if (!isOpen) return null;

    const validateForm = () => {
        const errors: Partial<Record<"name" | "price" | "components", string>> = {};
        const nameResult = validateRequiredText(name, "Multi-shift name", 50);
        const priceResult = parseIntegerField(price, "Bundle monthly price", { min: 0, max: FORM_LIMITS.moneyMax });
        if (!nameResult.ok) errors.name = nameResult.error;
        if (!priceResult.ok) errors.price = priceResult.error;
        if (selectedShiftIds.length < 2) errors.components = "Select at least 2 primary shifts.";
        if (duplicateCombo) errors.components = `A multi-shift with this exact combination already exists: "${duplicateCombo.name}".`;
        if (duplicateName) errors.name = `A multi-shift named "${name.trim()}" already exists.`;
        if (!nameResult.ok || !priceResult.ok || selectedShiftIds.length < 2 || !!duplicateCombo || !!duplicateName) {
            return { errors, values: null };
        }
        return { errors, values: { nameResult, priceResult } };
    };

    const validation = validateForm();
    const nameError = visibleError("name", validation.errors);
    const priceError = visibleError("price", validation.errors);
    const componentsError = visibleError("components", validation.errors);

    const handleSubmit = async () => {
        markSubmitted();
        setError(null);
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean) || !result.values) return;
        const { nameResult, priceResult } = result.values;

        setLoading(true);
        try {
            const url = mode === "edit" && initial
                ? `/api/branches/${branchId}/multi-shifts/${initial.id}`
                : `/api/branches/${branchId}/multi-shifts`;
            const method = mode === "edit" ? "PATCH" : "POST";

            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: nameResult.value,
                    price: priceResult.value ?? 0,
                    shiftIds: selectedShiftIds,
                }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || "Operation failed");
            }
            const saved = await res.json();
            onSuccess(saved);
        } catch (err: unknown) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const toggleShift = (id: string) => {
        markTouched("components");
        setSelectedShiftIds(prev =>
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
        );
        setError(null);
    };

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title={mode === "add" ? "Add multi-shift" : "Edit multi-shift"}
            description="Bundle two or more primary shifts under one monthly price."
            closeDisabled={loading}
            className="max-w-md"
            footer={(
                <>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={loading} className="h-11 px-4 text-sm">Cancel</Button>
                    <Button
                        type="button"
                        onClick={handleSubmit}
                        disabled={loading}
                        className="h-11 min-w-[100px] justify-center border border-orange-500/30 bg-orange-500/20 px-4 text-sm text-orange-300 hover:bg-orange-500/30"
                    >
                        {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : mode === "add" ? "Create bundle" : "Save changes"}
                    </Button>
                </>
            )}
        >
                <div className="space-y-5" aria-describedby={error ? "multi-shift-submit-error" : undefined}>
                    <div className="space-y-1.5">
                        <label htmlFor="multi-shift-name" className={formCompactLabelClass}>Bundle name *</label>
                        <input
                            id="multi-shift-name"
                            type="text"
                            value={name}
                            onChange={e => { setName(e.target.value); setError(null); }}
                            onBlur={() => markTouched("name")}
                            placeholder="e.g. Full Time"
                            data-dialog-initial-focus
                            className={cn(formControlClass, "px-4 py-2.5 text-sm focus:border-orange-500/50", fieldErrorClass(nameError))}
                            {...fieldErrorProps("multi-shift-name-error", nameError)}
                        />
                        <FieldError id="multi-shift-name-error" error={nameError} />
                    </div>

                    <div className="space-y-1.5">
                        <label htmlFor="multi-shift-price" className={formCompactLabelClass}>Bundle monthly price</label>
                        <div className="relative">
                            <IndianRupee size={13} className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} aria-hidden="true" />
                            <input
                                id="multi-shift-price"
                                type="number"
                                value={price}
                                onChange={e => { setPrice(e.target.value); setError(null); }}
                                onBlur={() => markTouched("price")}
                                min="0"
                                max={FORM_LIMITS.moneyMax}
                                step="1"
                                inputMode="numeric"
                                className={cn(formControlClass, "py-2.5 pl-8 pr-4 text-sm focus:border-orange-500/50", fieldErrorClass(priceError))}
                                {...fieldErrorProps("multi-shift-price-error", priceError)}
                            />
                        </div>
                        <FieldError id="multi-shift-price-error" error={priceError} />
                    </div>

                    <div role="group" aria-labelledby="multi-shift-components-label" aria-describedby={componentsError ? "multi-shift-components-error" : undefined} className="space-y-2.5">
                        <p id="multi-shift-components-label" className={cn("block", formCompactLabelClass)}>Component shifts *</p>
                        <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto pr-1">
                            {primaryShifts.map(s => (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => toggleShift(s.id)}
                                    aria-pressed={selectedShiftIds.includes(s.id)}
                                    className={cn(
                                        "flex cursor-pointer items-center justify-between rounded-[var(--ui-radius-control)] border px-3 py-2 text-left transition-all",
                                        selectedShiftIds.includes(s.id)
                                            ? "border-[color:var(--ui-badge-warning-border)] bg-[color:var(--ui-badge-warning-bg)] text-[color:var(--ui-badge-warning-text)]"
                                            : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] text-[color:var(--ui-form-label)] hover:border-[color:var(--ui-form-input-border)]"
                                    )}
                                >
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium">{s.name}</span>
                                        <span className="text-[10px] opacity-60 font-mono">{s.startTime} - {s.endTime}</span>
                                    </div>
                                    <div className={cn(
                                        "flex h-4 w-4 items-center justify-center rounded border transition-all",
                                        selectedShiftIds.includes(s.id)
                                            ? "border-[color:var(--ui-tone-warning-progress)] bg-[color:var(--ui-tone-warning-progress)]"
                                            : "border-[color:var(--ui-form-input-border)]"
                                    )}>
                                        {selectedShiftIds.includes(s.id) && <CheckCircle2 size={10} className="text-[color:var(--bg-app)]" aria-hidden="true" />}
                                    </div>
                                </button>
                            ))}
                        </div>
                        <FieldError id="multi-shift-components-error" error={componentsError} />
                    </div>

                    {error && (
                        <div id="multi-shift-submit-error" role="alert" className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                            <AlertCircle size={13} aria-hidden="true" /> {error}
                        </div>
                    )}
                </div>
        </Dialog>
    );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function ShiftsPage() {
    const params = useParams();
    const branchId = params?.branchId as string;

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.shifts}>
            {access => (
                <ShiftsContent
                    branchId={branchId}
                    manageDecision={getBranchCapabilityDecision(access, "shiftsManage")}
                />
            )}
        </BranchAccessGuard>
    );
}

function ShiftsContent({
    branchId,
    manageDecision,
}: {
    branchId: string;
    manageDecision: CapabilityDecision;
}) {
    const searchParams = useSearchParams();
    const targetShiftId = searchParams.get("shiftId");
    const { formatNumber } = useUserPreferences();
    const formatPrice = (value: number) => formatNumber(value, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });
    const canManageBranch = manageDecision.allowed;
    const showManageActions = manageDecision.blocker !== "permission";
    const shiftManageHelpText = manageDecision.reason ?? getPermissionHelpText("manage_branch");
    const toastApi = useToast();
    const [shifts, setShifts] = useState<Shift[]>([]);
    const [multiShifts, setMultiShifts] = useState<MultiShift[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Dialog state
    const [dialog, setDialog] = useState<{
        open: boolean;
        mode: "type-picker" | "add-primary" | "add-multi" | "edit-primary" | "edit-multi";
        shift?: Shift;
        multiShift?: MultiShift;
    }>({
        open: false, mode: "add-primary",
    });

    // Delete dialog state
    const [deleteTarget, setDeleteTarget] = useState<Shift | null>(null);
    const [deleteMultiTarget, setDeleteMultiTarget] = useState<MultiShift | null>(null);
    const [deletingMultiShift, setDeletingMultiShift] = useState(false);

    const showToast = (msg: string, type: "success" | "error" = "success") => {
        toastApi.show({ title: msg, tone: type });
    };

    const loadShifts = useCallback(async () => {
        if (!branchId) return;
        setLoading(true);
        try {
            const [shiftsRes, multiRes] = await Promise.all([
                fetch(`/api/branches/${branchId}/shifts`),
                fetch(`/api/branches/${branchId}/multi-shifts`)
            ]);
            
            if (!shiftsRes.ok || !multiRes.ok) throw new Error("Failed to load shifts");
            
            const [shiftsData, multiData] = await Promise.all([
                shiftsRes.json(),
                multiRes.json()
            ]);
            
            setShifts(shiftsData);
            setMultiShifts(multiData);
            setError(null);
        } catch (err: unknown) {
            setError(getErrorMessage(err, "Failed to load shifts"));
        } finally {
            setLoading(false);
        }
    }, [branchId]);

    useEffect(() => { loadShifts(); }, [loadShifts]);

    useEffect(() => {
        if (loading || !targetShiftId) return;

        const desktop = window.matchMedia("(min-width: 768px)").matches;
        const destinationIds = desktop
            ? [`shift-row-${targetShiftId}`, `shift-card-${targetShiftId}`]
            : [`shift-card-${targetShiftId}`, `shift-row-${targetShiftId}`];
        const target = destinationIds
            .map(id => document.getElementById(id))
            .find((element): element is HTMLElement => element !== null);
        if (!target) return;

        const focusFrame = window.requestAnimationFrame(() => {
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
            target.focus({ preventScroll: true });
        });
        return () => window.cancelAnimationFrame(focusFrame);
    }, [loading, multiShifts, shifts, targetShiftId]);

    const handleDialogSuccess = (saved: Shift) => {
        setShifts(prev => {
            const idx = prev.findIndex(s => s.id === saved.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
            return [...prev, saved];
        });
        showToast(dialog.mode === "add-primary" ? `"${saved.name}" added.` : `"${saved.name}" updated.`);
    };

    const handleDeleted = (shiftId: string) => {
        const deleted = shifts.find(s => s.id === shiftId);
        setShifts(prev => prev.filter(s => s.id !== shiftId));
        showToast(`"${deleted?.name}" deleted.`);
    };

    const handleRenamed = (updated: Shift) => {
        setShifts(prev => prev.map(s => s.id === updated.id ? updated : s));
        showToast(`"${updated.name}" updated.`);
    };

    // ── Loading
    if (loading) return <PageLoadingSkeleton label="Loading shifts" variant="table" rows={6} />;

    // ── Error
    if (error) return (
        <div className={pageErrorStateClass}>
            <AlertCircle className={pageErrorIconClass} />
            <p className={pageMutedTextClass}>{error}</p>
        </div>
    );

    const handleDeleteMultiShift = async () => {
        if (!deleteMultiTarget) return;
        if (!manageDecision.allowed) {
            showToast(manageDecision.reason ?? "Shift changes are unavailable.", "error");
            return;
        }

        setDeletingMultiShift(true);
        try {
            const res = await fetch(`/api/branches/${branchId}/multi-shifts/${deleteMultiTarget.id}`, { method: "DELETE" });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || "Failed to delete multi-shift bundle.");
            }

            const deletedName = deleteMultiTarget.name;
            setMultiShifts(prev => prev.filter(x => x.id !== deleteMultiTarget.id));
            setDeleteMultiTarget(null);
            showToast(`"${deletedName}" deleted.`);
        } catch (err: unknown) {
            showToast(getErrorMessage(err, "Failed to delete multi-shift bundle."), "error");
        } finally {
            setDeletingMultiShift(false);
        }
    };

    const primaryShiftActions = (shift: Shift): RowAction[] => [
        {
            label: "Edit",
            icon: Pencil,
            onClick: () => setDialog({ open: true, mode: "edit-primary", shift }),
            disabled: !canManageBranch,
            description: canManageBranch ? undefined : shiftManageHelpText,
        },
        {
            label: "Delete",
            icon: Trash2,
            variant: "danger",
            onClick: () => setDeleteTarget(shift),
            disabled: !canManageBranch,
            description: canManageBranch ? undefined : shiftManageHelpText,
        },
    ];

    const multiShiftActions = (ms: MultiShift): RowAction[] => [
        {
            label: "Edit",
            icon: Pencil,
            onClick: () => setDialog({ open: true, mode: "edit-multi", multiShift: ms }),
            disabled: !canManageBranch,
            description: canManageBranch ? undefined : shiftManageHelpText,
        },
        {
            label: "Delete",
            icon: Trash2,
            variant: "danger",
            onClick: () => setDeleteMultiTarget(ms),
            disabled: !canManageBranch,
            description: canManageBranch ? undefined : shiftManageHelpText,
        },
    ];

    const shiftCards = (
        <div className="grid gap-4">
            {shifts.map(shift => (
                <div
                    key={shift.id}
                    id={`shift-card-${shift.id}`}
                    tabIndex={targetShiftId === shift.id ? -1 : undefined}
                    aria-current={targetShiftId === shift.id ? "true" : undefined}
                    aria-label={targetShiftId === shift.id ? `${shift.name}, selected search result` : undefined}
                    className={cn(
                        pageGridCardClass,
                        pageGridCardHoverClass,
                        targetShiftId === shift.id && "border-cyan-400/50 bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60"
                    )}
                >
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="truncate font-medium text-[color:var(--text-primary)]">{shift.name}</p>
                            <div className="mt-2">
                                <Badge variant="warning" className="bg-yellow-500/10 text-yellow-300 border-yellow-500/20 font-bold tracking-wider text-[10px]">
                                    PRIMARY
                                </Badge>
                            </div>
                        </div>
                        {showManageActions ? (
                            <RowActions actions={primaryShiftActions(shift)} />
                        ) : (
                            <span className={cn("text-xs", pageSubtleTextClass)} title={shiftManageHelpText}>
                                View only
                            </span>
                        )}
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div className={pageInsetMetricClass}>
                            <div className={cn("text-xs", pageSubtleTextClass)}>Time Window</div>
                            <div className={cn("mt-1", pageMutedTextClass)}>
                                {shift.startTime && shift.endTime ? (
                                    <span className="font-mono text-xs">{shift.startTime} - {shift.endTime}</span>
                                ) : (
                                    <span className={cn("text-xs italic", pageSubtleTextClass)}>No time limit</span>
                                )}
                            </div>
                        </div>
                        <div className={pageInsetMetricClass}>
                            <div className={cn("text-xs", pageSubtleTextClass)}>Price</div>
                            <div className="mt-1 font-semibold text-[color:var(--text-primary)]">{formatPrice(shift.price)}</div>
                        </div>
                    </div>
                </div>
            ))}

            {multiShifts.map(ms => (
                <div
                    key={ms.id}
                    id={`shift-card-${ms.id}`}
                    tabIndex={targetShiftId === ms.id ? -1 : undefined}
                    aria-current={targetShiftId === ms.id ? "true" : undefined}
                    aria-label={targetShiftId === ms.id ? `${ms.name}, selected search result` : undefined}
                    className={cn(
                        pageGridCardClass,
                        pageGridCardHoverClass,
                        targetShiftId === ms.id && "border-cyan-400/50 bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60"
                    )}
                >
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="truncate font-medium text-[color:var(--text-primary)]">{ms.name}</p>
                            <div className="mt-2">
                                <Badge variant="warning" className="bg-orange-500/10 text-orange-300 border-orange-500/20 font-bold tracking-wider text-[10px]">
                                    MULTI-SHIFT
                                </Badge>
                            </div>
                        </div>
                        {showManageActions ? (
                            <RowActions actions={multiShiftActions(ms)} />
                        ) : (
                            <span className={cn("text-xs", pageSubtleTextClass)} title={shiftManageHelpText}>
                                View only
                            </span>
                        )}
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div className={pageInsetMetricClass}>
                            <div className={cn("text-xs", pageSubtleTextClass)}>Slots</div>
                            <div className={cn("mt-1 text-xs", pageMutedTextClass)}>{ms.components.length} combined</div>
                        </div>
                        <div className={pageInsetMetricClass}>
                            <div className={cn("text-xs", pageSubtleTextClass)}>Price</div>
                            <div className="mt-1 font-semibold text-[color:var(--text-primary)]">{formatPrice(ms.price)}</div>
                        </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {ms.components.map(c => (
                            <span key={c.shiftId} className="rounded border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] px-1.5 py-0.5 text-[10px] text-[color:var(--text-secondary)]">
                                {c.shiftName}
                            </span>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );

    return (
        <PageShell className="relative">
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <p className={pageEyebrowClass}>Branch setup</p>
                    <h1 className={cn(pageTitleClass, "mt-2")}>Shifts</h1>
                    <p className={pageDescriptionClass}>
                        Keep allocation windows simple: primary shifts first, multi-shift bundles only when students need combined access.
                    </p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <span className={pageMetaPillClass}>
                        {shifts.length} primary / {multiShifts.length} bundle{multiShifts.length === 1 ? "" : "s"}
                    </span>
                    {showManageActions && (
                        <AppButton
                            variant="primary"
                            icon={Clock}
                            onClick={() => setDialog({ open: true, mode: "type-picker" })}
                            disabled={!canManageBranch}
                            title={canManageBranch ? undefined : shiftManageHelpText}
                        >
                            Add shift
                        </AppButton>
                    )}
                </div>
            </header>

            {!canManageBranch && (
                <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)}>
                    Shift changes are disabled. {shiftManageHelpText}
                    {manageDecision.recoveryHref ? (
                        <a
                            href={manageDecision.recoveryHref}
                            className="ml-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
                        >
                            Review billing
                        </a>
                    ) : null}
                </div>
            )}

            {shifts.length === 0 && multiShifts.length === 0 ? (
                <div className={pageEmptyStateClass}>
                    <Clock size={36} className="mx-auto mb-3 opacity-30" />
                    <p>No shifts found.</p>
                    {showManageActions && (
                        <AppButton
                            variant="secondary"
                            size="sm"
                            icon={Clock}
                            onClick={() => setDialog({ open: true, mode: "type-picker" })}
                            disabled={!canManageBranch}
                            title={canManageBranch ? undefined : shiftManageHelpText}
                            className="mt-3"
                        >
                            Add your first shift
                        </AppButton>
                    )}
                </div>
            ) : (
                <>
                <div className="md:hidden">{shiftCards}</div>
                <div className={cn("hidden overflow-visible md:block", pageTableShellClass)}>
                    <div
                        className="w-full overflow-x-auto"
                        role="region"
                        aria-label="Branch shifts"
                        tabIndex={0}
                    >
                    <table className="w-full min-w-[54rem] text-left text-sm">
                        <caption className="sr-only">Primary shifts and multi-shift bundles for this branch</caption>
                        <thead className={pageTableHeadClass}>
                            <tr className="border-b border-[color:var(--ui-table-divider)] text-[color:var(--ui-table-muted)]">
                                <th scope="col" className="px-6 py-4 font-semibold">Shift Name</th>
                                <th scope="col" className="px-6 py-4 font-semibold">Type</th>
                                <th scope="col" className="px-6 py-4 font-semibold">Time Window</th>
                                <th scope="col" className="px-6 py-4 font-semibold">Price</th>
                                <th scope="col" className="px-6 py-4 text-right font-semibold">Actions</th>
                            </tr>
                        </thead>
                        <tbody className={pageTableBodyDividerClass}>
                            {/* Primary Shifts */}
                            {shifts.map(shift => (
                                <tr
                                    key={shift.id}
                                    id={`shift-row-${shift.id}`}
                                    tabIndex={targetShiftId === shift.id ? -1 : undefined}
                                    aria-current={targetShiftId === shift.id ? "true" : undefined}
                                    aria-label={targetShiftId === shift.id ? `${shift.name}, selected search result` : undefined}
                                    className={cn(
                                        "group",
                                        pageTableRowClass,
                                        targetShiftId === shift.id && "bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60"
                                    )}
                                >
                                    <th scope="row" className="px-6 py-4 text-left font-medium text-[color:var(--ui-table-text)]">{shift.name}</th>
                                    <th scope="row" className="px-6 py-4 text-left font-normal">
                                        <Badge variant="warning" className="bg-yellow-500/10 text-yellow-300 border-yellow-500/20 font-bold tracking-wider text-[10px]">
                                            PRIMARY
                                        </Badge>
                                    </th>
                                    <td className="px-6 py-4 text-[color:var(--ui-table-muted)]">
                                        {shift.startTime && shift.endTime ? (
                                            <span className="font-mono flex items-center gap-1.5">
                                                <Clock size={12} className="text-[color:var(--ui-table-subtle)]" />
                                                {shift.startTime} - {shift.endTime}
                                            </span>
                                        ) : (
                                            <span className="text-xs italic text-[color:var(--ui-table-subtle)]">No time limit</span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 font-medium text-[color:var(--ui-table-text)]">{formatPrice(shift.price)}</td>
                                    <td className="px-6 py-4 text-right">
                                        {showManageActions ? (
                                            <RowActions actions={primaryShiftActions(shift)} />
                                        ) : (
                                            <span className="text-xs text-[color:var(--ui-table-subtle)]" title={shiftManageHelpText}>
                                                View only
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}

                            {/* Multi Shifts */}
                            {multiShifts.map(ms => (
                                <tr
                                    key={ms.id}
                                    id={`shift-row-${ms.id}`}
                                    tabIndex={targetShiftId === ms.id ? -1 : undefined}
                                    aria-current={targetShiftId === ms.id ? "true" : undefined}
                                    aria-label={targetShiftId === ms.id ? `${ms.name}, selected search result` : undefined}
                                    className={cn(
                                        "group",
                                        pageTableRowClass,
                                        targetShiftId === ms.id && "bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60"
                                    )}
                                >
                                    <td className="px-6 py-4">
                                        <div className="flex flex-col">
                                            <span className="font-medium text-[color:var(--ui-table-text)]">{ms.name}</span>
                                            <div className="flex flex-wrap gap-1 mt-1">
                                                {ms.components.map(c => (
                                                    <span key={c.shiftId} className="rounded border border-[color:var(--ui-table-border)] bg-[color:var(--ui-table-action-bg)] px-1.5 py-0.5 text-[9px] text-[color:var(--ui-table-muted)]">
                                                        {c.shiftName}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <Badge variant="warning" className="bg-orange-500/10 text-orange-300 border-orange-500/20 font-bold tracking-wider text-[10px]">
                                            MULTI-SHIFT
                                        </Badge>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="text-xs text-[color:var(--ui-table-subtle)]">
                                            {ms.components.length} slots combined
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 font-medium text-[color:var(--ui-table-text)]">{formatPrice(ms.price)}</td>
                                    <td className="px-6 py-4 text-right">
                                        {showManageActions ? (
                                            <RowActions actions={multiShiftActions(ms)} />
                                        ) : (
                                            <span className="text-xs text-[color:var(--ui-table-subtle)]" title={shiftManageHelpText}>
                                                View only
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    </div>
                </div>
                </>
            )}

            {canManageBranch && (
                <>
                    <TypePickerDialog
                        isOpen={dialog.open && dialog.mode === "type-picker"}
                        onClose={() => setDialog({ ...dialog, open: false })}
                        onSelect={(type) => setDialog({ open: true, mode: type === "primary" ? "add-primary" : "add-multi" })}
                    />

                    <ShiftDialog
                        isOpen={dialog.open && (dialog.mode === "add-primary" || dialog.mode === "edit-primary")}
                        mode={dialog.mode === "add-primary" ? "add" : "edit"}
                        initial={dialog.shift}
                        branchId={branchId}
                        existingShifts={shifts}
                        onClose={() => setDialog({ ...dialog, open: false })}
                        onSuccess={handleDialogSuccess}
                    />

                    <MultiShiftDialog
                        isOpen={dialog.open && (dialog.mode === "add-multi" || dialog.mode === "edit-multi")}
                        mode={dialog.mode === "add-multi" ? "add" : "edit"}
                        initial={dialog.multiShift}
                        branchId={branchId}
                        primaryShifts={shifts}
                        existingMultiShifts={multiShifts}
                        onClose={() => setDialog({ ...dialog, open: false })}
                        onSuccess={(ms) => {
                            if (dialog.mode === "add-multi") setMultiShifts([...multiShifts, ms]);
                            else setMultiShifts(multiShifts.map(x => x.id === ms.id ? ms : x));
                            showToast(dialog.mode === "add-multi" ? `"${ms.name}" added.` : `"${ms.name}" updated.`);
                            setDialog({ ...dialog, open: false });
                        }}
                    />

                    {deleteTarget && (
                        <DeleteShiftDialog
                            shift={deleteTarget}
                            branchId={branchId}
                            existingShifts={shifts}
                            onClose={() => setDeleteTarget(null)}
                            onDeleted={handleDeleted}
                            onRenamed={handleRenamed}
                        />
                    )}

                    <ConfirmDialog
                        isOpen={deleteMultiTarget !== null}
                        onClose={() => {
                            if (!deletingMultiShift) setDeleteMultiTarget(null);
                        }}
                        onConfirm={handleDeleteMultiShift}
                        title="Delete multi-shift bundle?"
                        description={deleteMultiTarget
                            ? <>&ldquo;{deleteMultiTarget.name}&rdquo; will be removed. Student allocations remain, but their bundle grouping will be lost.</>
                            : "This multi-shift bundle will be removed."
                        }
                        confirmText="Delete bundle"
                        loading={deletingMultiShift}
                        variant="danger"
                    />
                </>
            )}
        </PageShell>
    );
}
