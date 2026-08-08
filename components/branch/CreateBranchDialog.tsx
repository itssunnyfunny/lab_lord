"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { X, MapPin, Loader2, Phone, Plus, AlertCircle, AlertTriangle } from "lucide-react";
import {
    SeatNumberingBuilder,
    createSimpleSeatNumbering,
    resolveSeatNumberingForCount,
} from "@/components/seats/SeatNumberingBuilder";
import {
    formControlClass,
    formErrorBannerClass,
    formHelpTextClass,
    formIconClass,
    formInlineControlClass,
    formLabelClass,
    formRequiredClass,
    formSurfaceClass,
    formWarningActionClass,
    formWarningBannerClass,
} from "@/components/ui/formSurface";
import { FieldError, fieldErrorClass, fieldErrorProps, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { parseNullableTime, timesOverlap } from "@/utils/shiftTime";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalText,
    validateRequiredPhone,
    validateRequiredText,
    validateShiftDrafts,
} from "@/lib/formValidation";
import { generateSeatLabelsForSeatCount, type SeatNumberingConfig } from "@/lib/seatNumbering";
import { cn } from "@/lib/utils";

function formatMins(mins: number) {
    let raw = mins;
    if (raw < 0) raw += 1440;
    raw = raw % 1440;
    const h = Math.floor(raw / 60);
    const m = raw % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

interface ShiftDraft {
    name: string;
    startTime: string;
    endTime: string;
    price: number | string;
}

interface CreateBranchDialogProps {
    isOpen: boolean;
    onClose: () => void;
    /** The org this branch belongs to */
    organizationId: string;
    /** Called with the newly created branch after success */
    onSuccess: (branch: { id: string; name: string }) => void;
}

const DEFAULT_SHIFTS: ShiftDraft[] = [
    { name: "Morning", startTime: "06:00", endTime: "09:59", price: 0 },
    { name: "Afternoon", startTime: "10:00", endTime: "15:59", price: 0 },
    { name: "Evening", startTime: "16:00", endTime: "21:59", price: 0 },
];


export function CreateBranchDialog({
    isOpen,
    onClose,
    organizationId,
    onSuccess,
}: CreateBranchDialogProps) {
    const [formData, setFormData] = useState({
        name: "",
        contactPhone: "",
        city: "",
        seatCount: "",
        seatNumbering: createSimpleSeatNumbering(),
        defaultFee: "",
    });
    const [shifts, setShifts] = useState<ShiftDraft[]>(DEFAULT_SHIFTS);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<"name" | "contactPhone" | "city" | "seatCount" | "seatNumbering" | "defaultFee" | "shifts">();

    // Compute overlaps continuously
    const overlaps = (() => {
        const issues = new Map<number, { targetShiftIdx: number; text: string; fix1: { idx: number; field: "startTime" | "endTime"; val: string; label: string }; fix2: { idx: number; field: "startTime" | "endTime"; val: string; label: string } }>();
        for (let i = 0; i < shifts.length; i++) {
            for (let j = i + 1; j < shifts.length; j++) {
                const s1 = shifts[i];
                const s2 = shifts[j];
                if (!s1.startTime || !s1.endTime || !s2.startTime || !s2.endTime) continue;

                const start1 = parseNullableTime(s1.startTime);
                const end1 = parseNullableTime(s1.endTime);
                const start2 = parseNullableTime(s2.startTime);
                const end2 = parseNullableTime(s2.endTime);

                if (timesOverlap(start1, end1, start2, end2)) {
                    issues.set(j, { // Display on the later shift
                        targetShiftIdx: i,
                        text: `Overlaps with "${s1.name || 'another shift'}"`,
                        fix1: { idx: i, field: "endTime", val: formatMins(start2! - 1), label: `End ${s1.name || '1st'} at ${formatMins(start2! - 1)}` },
                        fix2: { idx: j, field: "startTime", val: formatMins(end1! + 1), label: `Start ${s2.name || '2nd'} at ${formatMins(end1! + 1)}` }
                    });
                }
            }
        }
        return issues;
    })();

    if (!isOpen) return null;

    const validateForm = () => {
        const errors: Partial<Record<"name" | "contactPhone" | "city" | "seatCount" | "seatNumbering" | "defaultFee" | "shifts", string>> = {};
        const nameResult = validateRequiredText(formData.name, "Branch name", 120);
        const contactPhoneResult = validateRequiredPhone(formData.contactPhone, "Contact phone");
        const cityResult = validateOptionalText(formData.city, "City / area", FORM_LIMITS.cityMax);
        const seatCountResult = parseIntegerField(formData.seatCount, "Total seats", {
            required: true,
            min: 1,
            max: FORM_LIMITS.seatsMax,
        });
        const defaultFeeResult = parseIntegerField(formData.defaultFee, "Default monthly fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        const shiftsResult = validateShiftDrafts(shifts);
        const seatNumberingConfig = seatCountResult.ok
            ? resolveSeatNumberingForCount(formData.seatNumbering as SeatNumberingConfig, seatCountResult.value ?? 0)
            : formData.seatNumbering as SeatNumberingConfig;
        const seatNumberingResult = seatCountResult.ok
            ? generateSeatLabelsForSeatCount(seatCountResult.value, seatNumberingConfig)
            : { ok: true as const, value: [] };

        if (!nameResult.ok) errors.name = nameResult.error;
        if (!contactPhoneResult.ok) errors.contactPhone = contactPhoneResult.error;
        if (!cityResult.ok) errors.city = cityResult.error;
        if (!seatCountResult.ok) errors.seatCount = seatCountResult.error;
        if (!seatNumberingResult.ok) errors.seatNumbering = seatNumberingResult.error;
        if (!defaultFeeResult.ok) errors.defaultFee = defaultFeeResult.error;
        if (!shiftsResult.ok) errors.shifts = shiftsResult.error;
        if (overlaps.size > 0) errors.shifts = "Resolve all shift time overlaps before continuing.";

        if (
            !nameResult.ok ||
            !contactPhoneResult.ok ||
            !cityResult.ok ||
            !seatCountResult.ok ||
            !seatNumberingResult.ok ||
            !defaultFeeResult.ok ||
            !shiftsResult.ok ||
            overlaps.size > 0
        ) return { errors, values: null };
        return { errors, values: { nameResult, contactPhoneResult, cityResult, seatCountResult, seatNumberingConfig, defaultFeeResult, shiftsResult } };
    };

    const validation = validateForm();
    const seatCountPreviewResult = parseIntegerField(formData.seatCount, "Total seats", {
        required: true,
        min: 1,
        max: FORM_LIMITS.seatsMax,
    });
    const seatCountPreview = seatCountPreviewResult.ok ? seatCountPreviewResult.value : undefined;
    const nameError = visibleError("name", validation.errors);
    const contactPhoneError = visibleError("contactPhone", validation.errors);
    const cityError = visibleError("city", validation.errors);
    const seatCountError = visibleError("seatCount", validation.errors);
    const seatNumberingError = visibleError("seatNumbering", validation.errors);
    const defaultFeeError = visibleError("defaultFee", validation.errors);
    const shiftsError = visibleError("shifts", validation.errors);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleShiftChange = (idx: number, field: keyof ShiftDraft, value: string | number) => {
        markTouched("shifts");
        setShifts(prev => {
            const next = [...prev];
            next[idx] = { ...next[idx], [field]: value };
            return next;
        });
    };

    const addShift = () => {
        markTouched("shifts");
        setShifts(prev => [...prev, { name: "", startTime: "", endTime: "", price: 0 }]);
    };

    const removeShift = (idx: number) => {
        markTouched("shifts");
        setShifts(prev => prev.filter((_, i) => i !== idx));
    };

    const handleSubmit = async () => {
        markSubmitted();
        setError(null);
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean) || !result.values) {
            return;
        }
        const { nameResult, contactPhoneResult, cityResult, seatCountResult, seatNumberingConfig, defaultFeeResult, shiftsResult } = result.values;

        setLoading(true);
        try {
            const res = await fetch("/api/branches", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    organizationId,
                    name: nameResult.value,
                    contactPhone: contactPhoneResult.value,
                    city: cityResult.value,
                    seatCount: seatCountResult.value,
                    seatNumbering: seatNumberingConfig,
                    defaultFee: defaultFeeResult.value ?? 0,
                    shifts: shiftsResult.value,
                }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || "Failed to create branch");
            }

            const branch = await res.json();
            // Reset form
            setFormData({ name: "", contactPhone: "", city: "", seatCount: "", seatNumbering: createSimpleSeatNumbering(), defaultFee: "" });
            setShifts(DEFAULT_SHIFTS);
            resetFieldErrors();
            onSuccess(branch);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Something went wrong.");
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        if (loading) return;
        setFormData({ name: "", contactPhone: "", city: "", seatCount: "", seatNumbering: createSimpleSeatNumbering(), defaultFee: "" });
        setShifts(DEFAULT_SHIFTS);
        setError(null);
        resetFieldErrors();
        onClose();
    };

    return (
        <Dialog
            open={isOpen}
            onClose={handleClose}
            title="Create new branch"
            description="Set up a new location under this organization."
            closeLabel="Close create branch dialog"
            closeDisabled={loading}
            className="max-w-lg"
            footer={(
                <>
                    <Button variant="ghost" onClick={handleClose} disabled={loading}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={loading}
                        className="min-w-[130px] justify-center"
                    >
                        {loading ? (
                            <><Loader2 size={14} className="mr-2 animate-spin" aria-hidden="true" /> Creating...</>
                        ) : (
                            "Create Branch"
                        )}
                    </Button>
                </>
            )}
        >
                <div className="space-y-5" aria-describedby={error ? "create-branch-submit-error" : undefined}>
                    {/* Branch Name */}
                    <div className="space-y-1.5">
                        <label htmlFor="create-branch-name" className={formLabelClass}>
                            Branch Name <span className={formRequiredClass}>*</span>
                        </label>
                        <div className="relative">
                            <MapPin className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} size={16} aria-hidden="true" />
                            <input
                                id="create-branch-name"
                                type="text"
                                name="name"
                                value={formData.name}
                                onChange={handleChange}
                                onBlur={() => markTouched("name")}
                                placeholder="e.g. Main Branch, Downtown"
                                data-dialog-initial-focus
                                maxLength={120}
                                className={cn(formControlClass, "py-2.5 pl-9 pr-4 text-sm", fieldErrorClass(nameError))}
                                {...fieldErrorProps("create-branch-name-error", nameError)}
                            />
                        </div>
                        <FieldError id="create-branch-name-error" error={nameError} />
                    </div>

                    <div className="space-y-1.5">
                        <label htmlFor="create-branch-contact-phone" className={formLabelClass}>
                            Contact Phone <span className={formRequiredClass}>*</span>
                        </label>
                        <div className="relative">
                            <Phone className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} size={16} aria-hidden="true" />
                            <input
                                id="create-branch-contact-phone"
                                type="tel"
                                name="contactPhone"
                                value={formData.contactPhone}
                                onChange={handleChange}
                                onBlur={() => markTouched("contactPhone")}
                                placeholder="+91 98765 43210"
                                className={cn(formControlClass, "py-2.5 pl-9 pr-4 text-sm", fieldErrorClass(contactPhoneError))}
                                {...fieldErrorProps("create-branch-contact-phone-error", contactPhoneError)}
                            />
                        </div>
                        <FieldError id="create-branch-contact-phone-error" error={contactPhoneError} />
                    </div>

                    {/* City + Seats */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <label htmlFor="create-branch-city" className={formLabelClass}>
                                City / Area <span className={formHelpTextClass}>(Optional)</span>
                            </label>
                            <input
                                id="create-branch-city"
                                type="text"
                                name="city"
                                value={formData.city}
                                onChange={handleChange}
                                onBlur={() => markTouched("city")}
                                placeholder="e.g. Mumbai"
                                maxLength={FORM_LIMITS.cityMax}
                                className={cn(formControlClass, "px-4 py-2.5 text-sm", fieldErrorClass(cityError))}
                                {...fieldErrorProps("create-branch-city-error", cityError)}
                            />
                            <FieldError id="create-branch-city-error" error={cityError} />
                        </div>
                        <div className="space-y-1.5">
                            <label htmlFor="create-branch-seat-count" className={formLabelClass}>
                                Total Seats <span className={formRequiredClass}>*</span>
                            </label>
                            <input
                                id="create-branch-seat-count"
                                type="number"
                                name="seatCount"
                                value={formData.seatCount}
                                onChange={handleChange}
                                onBlur={() => markTouched("seatCount")}
                                placeholder="e.g. 50"
                                min="1"
                                max={FORM_LIMITS.seatsMax}
                                step="1"
                                inputMode="numeric"
                                className={cn(formControlClass, "px-4 py-2.5 text-sm", fieldErrorClass(seatCountError))}
                                {...fieldErrorProps("create-branch-seat-count-error", seatCountError)}
                            />
                            <FieldError id="create-branch-seat-count-error" error={seatCountError} />
                        </div>
                    </div>

                    <div
                        className="space-y-2"
                        role="group"
                        aria-labelledby="create-branch-seat-numbering-label"
                        aria-describedby={seatNumberingError ? "create-branch-seat-numbering-error" : undefined}
                    >
                        <p id="create-branch-seat-numbering-label" className={formLabelClass}>Seat numbering</p>
                        <SeatNumberingBuilder
                            value={formData.seatNumbering as SeatNumberingConfig}
                            expectedCount={seatCountPreview}
                            onChange={(seatNumbering) => {
                                markTouched("seatNumbering");
                                setFormData(prev => ({ ...prev, seatNumbering }));
                            }}
                            disabled={loading}
                        />
                        <FieldError id="create-branch-seat-numbering-error" error={seatNumberingError} />
                    </div>

                    {/* Default Monthly Fee */}
                    <div className="space-y-1.5">
                        <label htmlFor="create-branch-default-fee" className={formLabelClass}>
                            Default Monthly Fee <span className={formHelpTextClass}>(Optional)</span>
                        </label>
                        <div className="relative">
                            <span className={cn("absolute left-3 top-1/2 -translate-y-1/2 text-sm", formIconClass)}>₹</span>
                            <input
                                id="create-branch-default-fee"
                                type="number"
                                name="defaultFee"
                                value={formData.defaultFee}
                                onChange={handleChange}
                                onBlur={() => markTouched("defaultFee")}
                                placeholder="e.g. 1500"
                                min="0"
                                max={FORM_LIMITS.moneyMax}
                                step="1"
                                inputMode="numeric"
                                className={cn(formControlClass, "py-2.5 pl-7 pr-4 text-sm", fieldErrorClass(defaultFeeError))}
                                {...fieldErrorProps("create-branch-default-fee-error", defaultFeeError)}
                            />
                        </div>
                        <FieldError id="create-branch-default-fee-error" error={defaultFeeError} />
                    </div>

                    {/* Shifts */}
                    <div
                        className="space-y-2"
                        role="group"
                        aria-labelledby="create-branch-shifts-label"
                        aria-describedby={shiftsError ? "create-branch-shifts-error" : undefined}
                    >
                        <div className="flex items-center justify-between">
                            <p id="create-branch-shifts-label" className={formLabelClass}>Shifts & Pricing</p>
                            <button
                                type="button"
                                onClick={addShift}
                                className="flex items-center gap-1 text-xs text-[color:var(--ui-form-accent)] transition-colors hover:text-[color:var(--ui-form-accent-hover)]"
                            >
                                <Plus size={12} aria-hidden="true" /> Add Shift
                            </button>
                        </div>

                        <div className="space-y-3">
                            {shifts.map((shift, idx) => (
                                <div key={idx} className="flex flex-col gap-1">
                                <div className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center", formSurfaceClass)}>
                                    <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-12 sm:items-center">
                                        <div className="col-span-2 sm:col-span-4">
                                            <input
                                                type="text"
                                                aria-label={`Shift ${idx + 1} name`}
                                                placeholder="Name"
                                                value={shift.name}
                                                onChange={(e) => handleShiftChange(idx, "name", e.target.value)}
                                                className={cn(formInlineControlClass, "py-1 text-xs")}
                                            />
                                        </div>
                                        <div className="col-span-1 sm:col-span-3">
                                            <input
                                                type="time"
                                                aria-label={`Shift ${idx + 1} start time`}
                                                value={shift.startTime}
                                                onChange={(e) => handleShiftChange(idx, "startTime", e.target.value)}
                                                className={cn(formInlineControlClass, "py-1 text-xs")}
                                            />
                                        </div>
                                        <div className="col-span-1 sm:col-span-3">
                                            <input
                                                type="time"
                                                aria-label={`Shift ${idx + 1} end time`}
                                                value={shift.endTime}
                                                onChange={(e) => handleShiftChange(idx, "endTime", e.target.value)}
                                                className={cn(formInlineControlClass, "py-1 text-xs")}
                                            />
                                        </div>
                                        <div className="col-span-2 relative sm:col-span-2">
                                            <span className={cn("absolute left-0 top-1 text-xs", formIconClass)}>₹</span>
                                            <input
                                                type="number"
                                                aria-label={`Shift ${idx + 1} monthly price`}
                                                placeholder="0"
                                                value={shift.price}
                                                onChange={(e) => handleShiftChange(idx, "price", e.target.value)}
                                                min={0}
                                                max={FORM_LIMITS.moneyMax}
                                                step={1}
                                                inputMode="numeric"
                                                className={cn(formInlineControlClass, "py-1 pl-3 text-xs")}
                                            />
                                        </div>
                                    </div>
                                    {shifts.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => removeShift(idx)}
                                            aria-label={`Remove shift ${shift.name || idx + 1}`}
                                            className={cn("flex-shrink-0 self-end transition-colors hover:text-[color:var(--ui-form-error-text)] sm:ml-1 sm:self-auto", formHelpTextClass)}
                                        >
                                            <X size={14} aria-hidden="true" />
                                        </button>
                                    )}
                                </div>
                                {overlaps.has(idx) && (
                                    <div className={cn("mt-1 flex flex-col gap-1.5 px-3 py-2 text-xs", formWarningBannerClass)}>
                                        <div className="flex items-center gap-1.5">
                                            <AlertTriangle size={12} aria-hidden="true" />
                                            <span>{overlaps.get(idx)!.text}</span>
                                        </div>
                                        <div className="flex flex-col gap-2 sm:flex-row">
                                            <button type="button" onClick={() => handleShiftChange(overlaps.get(idx)!.fix1.idx, overlaps.get(idx)!.fix1.field, overlaps.get(idx)!.fix1.val)} className={cn("px-2 py-1", formWarningActionClass)}>
                                                {overlaps.get(idx)!.fix1.label}
                                            </button>
                                            <button type="button" onClick={() => handleShiftChange(overlaps.get(idx)!.fix2.idx, overlaps.get(idx)!.fix2.field, overlaps.get(idx)!.fix2.val)} className={cn("px-2 py-1", formWarningActionClass)}>
                                                {overlaps.get(idx)!.fix2.label}
                                            </button>
                                        </div>
                                    </div>
                                )}
                                </div>
                            ))}
                        </div>
                        <FieldError id="create-branch-shifts-error" error={shiftsError} />
                    </div>

                    {/* Error */}
                    {error && (
                        <div id="create-branch-submit-error" role="alert" className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                            <AlertCircle size={14} aria-hidden="true" />
                            {error}
                        </div>
                    )}
                </div>
        </Dialog>
    );
}
