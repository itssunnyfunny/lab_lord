"use client";

import type { ChangeEvent } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppButton } from "@/components/ui";
import {
    SeatNumberingBuilder,
    createSimpleSeatNumbering,
    resolveSeatNumberingForCount,
} from "@/components/seats/SeatNumberingBuilder";
import {
    entryContentClass,
    entryIconFrameClass,
    entryInlineInfoClass,
    entryMutedTextClass,
    entryPanelClass,
    entryRootClass,
    entrySubtitleClass,
    entryTitleClass,
} from "@/components/ui/entrySurface";
import {
    formControlClass,
    formErrorBannerClass,
    formHelpTextClass,
    formIconClass,
    formInlineControlClass,
    formLabelClass,
    formRequiredClass,
    formSuccessBannerClass,
    formSurfaceClass,
    formSurfaceHoverClass,
} from "@/components/ui/formSurface";
import { FieldError, fieldErrorClass, fieldErrorProps, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, Layers, LayoutDashboard, MapPin, Phone, Plus, UploadCloud, X } from "lucide-react";
import { LogoMark } from "@/components/brand/AppLogo";
import { apiClient } from "@/lib/api/core";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalText,
    validateRequiredPhone,
    validateRequiredText,
    validateMultiShiftDrafts,
    validateShiftDrafts,
} from "@/lib/formValidation";
import { generateSeatLabelsForSeatCount, type SeatNumberingConfig } from "@/lib/seatNumbering";
import { cn } from "@/lib/utils";

interface OnboardingShiftDraft {
    clientId: string;
    name: string;
    startTime: string;
    endTime: string;
    price: number | string;
}

interface OnboardingMultiShiftDraft {
    clientId: string;
    name: string;
    price: number | string;
    componentShiftIds: string[];
}

interface OnboardingResponse {
    branch: {
        id: string;
    };
}

type FieldKey = "orgName" | "ownerPhone" | "businessType" | "branchName" | "city" | "seatCount" | "seatNumbering" | "shifts" | "multiShifts";
type OnboardingStep = 1 | 2 | 3;

const DEFAULT_SHIFT_IDS = {
    morning: "default-morning",
    afternoon: "default-afternoon",
    evening: "default-evening",
} as const;

const DEFAULT_ONBOARDING_SHIFTS: OnboardingShiftDraft[] = [
    { clientId: DEFAULT_SHIFT_IDS.morning, name: "Morning", startTime: "06:00", endTime: "09:59", price: 0 },
    { clientId: DEFAULT_SHIFT_IDS.afternoon, name: "Afternoon", startTime: "10:00", endTime: "15:59", price: 0 },
    { clientId: DEFAULT_SHIFT_IDS.evening, name: "Evening", startTime: "16:00", endTime: "21:59", price: 0 },
];

const DEFAULT_ONBOARDING_MULTI_SHIFTS: OnboardingMultiShiftDraft[] = [{
    clientId: "default-full-time",
    name: "Full Time",
    price: 0,
    componentShiftIds: [DEFAULT_SHIFT_IDS.morning, DEFAULT_SHIFT_IDS.afternoon, DEFAULT_SHIFT_IDS.evening],
}];

function createDraftId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function numericDraftPrice(value: number | string) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (!/^\d+$/.test(value.trim())) return 0;
    return Number(value);
}

function formatPrice(value: number) {
    return `Rs ${value.toLocaleString("en-IN")}`;
}

const stepItems = [
    { step: 1, label: "Organization", description: "Business identity and owner contact" },
    { step: 2, label: "First branch", description: "Seats, location, shifts, and pricing" },
    { step: 3, label: "Import assistance", description: "Import existing records or begin with a clean workspace" },
] as const;

const stepHeadings: Record<OnboardingStep, string> = {
    1: "Organization details",
    2: "First branch details",
    3: "Import assistance",
};

const stepDescriptions: Record<OnboardingStep, string> = {
    1: "Name the business and add the owner contact used for operations.",
    2: "Define a usable branch with seats and shifts before entering the dashboard.",
    3: "Choose whether this branch should begin with imported records or a clean workspace.",
};

export default function OnboardingPage() {
    const router = useRouter();
    const [step, setStep] = useState<OnboardingStep>(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [createdBranchId, setCreatedBranchId] = useState<string | null>(null);
    const {
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    } = useInlineFieldErrors<FieldKey>();

    const [formData, setFormData] = useState({
        orgName: "",
        ownerPhone: "",
        businessType: "",
        branchName: "",
        city: "",
        seatCount: "",
        seatNumbering: createSimpleSeatNumbering(),
        shifts: DEFAULT_ONBOARDING_SHIFTS,
        multiShifts: DEFAULT_ONBOARDING_MULTI_SHIFTS,
    });

    const handleInputChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        setError(null);
    };

    const handleShiftChange = (index: number, field: keyof OnboardingShiftDraft, value: string | number) => {
        markTouched("shifts");
        const newShifts = [...formData.shifts];
        newShifts[index] = { ...newShifts[index], [field]: value };
        setFormData(prev => ({ ...prev, shifts: newShifts }));
        setError(null);
    };

    const addShift = () => {
        markTouched("shifts");
        setFormData(prev => ({
            ...prev,
            shifts: [...prev.shifts, { clientId: createDraftId("shift"), name: "", startTime: "", endTime: "", price: 0 }],
        }));
    };

    const removeShift = (index: number) => {
        markTouched("shifts");
        markTouched("multiShifts");
        setFormData(prev => ({
            ...prev,
            shifts: prev.shifts.filter((_, i) => i !== index),
            multiShifts: prev.multiShifts.map(multiShift => ({
                ...multiShift,
                componentShiftIds: multiShift.componentShiftIds.filter(id => id !== prev.shifts[index]?.clientId),
            })),
        }));
    };

    const addMultiShift = () => {
        markTouched("multiShifts");
        setFormData(prev => {
            const componentShiftIds = prev.shifts.slice(0, 2).map(shift => shift.clientId);
            const suggestedPrice = prev.shifts
                .filter(shift => componentShiftIds.includes(shift.clientId))
                .reduce((total, shift) => total + numericDraftPrice(shift.price), 0);

            return {
                ...prev,
                multiShifts: [
                    ...prev.multiShifts,
                    {
                        clientId: createDraftId("multi-shift"),
                        name: "",
                        price: suggestedPrice,
                        componentShiftIds,
                    },
                ],
            };
        });
    };

    const removeMultiShift = (index: number) => {
        markTouched("multiShifts");
        setFormData(prev => ({
            ...prev,
            multiShifts: prev.multiShifts.filter((_, i) => i !== index),
        }));
    };

    const handleMultiShiftChange = (
        index: number,
        field: keyof Pick<OnboardingMultiShiftDraft, "name" | "price">,
        value: string | number
    ) => {
        markTouched("multiShifts");
        const newMultiShifts = [...formData.multiShifts];
        newMultiShifts[index] = { ...newMultiShifts[index], [field]: value };
        setFormData(prev => ({ ...prev, multiShifts: newMultiShifts }));
        setError(null);
    };

    const toggleMultiShiftComponent = (index: number, shiftId: string) => {
        markTouched("multiShifts");
        setFormData(prev => ({
            ...prev,
            multiShifts: prev.multiShifts.map((multiShift, i) => {
                if (i !== index) return multiShift;
                const selected = multiShift.componentShiftIds.includes(shiftId);
                return {
                    ...multiShift,
                    componentShiftIds: selected
                        ? multiShift.componentShiftIds.filter(id => id !== shiftId)
                        : [...multiShift.componentShiftIds, shiftId],
                };
            }),
        }));
        setError(null);
    };

    const applySuggestedMultiShiftPrice = (index: number) => {
        const suggestion = getSuggestedMultiShiftPrice(formData.multiShifts[index]);
        handleMultiShiftChange(index, "price", suggestion);
    };

    const shiftById = new Map(formData.shifts.map(shift => [shift.clientId, shift]));

    const getSuggestedMultiShiftPrice = (multiShift: OnboardingMultiShiftDraft | undefined) => {
        if (!multiShift) return 0;
        return multiShift.componentShiftIds.reduce((total, shiftId) => {
            const shift = shiftById.get(shiftId);
            return total + (shift ? numericDraftPrice(shift.price) : 0);
        }, 0);
    };

    const getMultiShiftInputs = () => formData.multiShifts.map(multiShift => ({
        name: multiShift.name,
        price: multiShift.price,
        componentShiftNames: multiShift.componentShiftIds
            .map(shiftId => shiftById.get(shiftId)?.name ?? "")
            .filter(Boolean),
    }));

    const validateForm = () => {
        const errors: Partial<Record<FieldKey, string>> = {};
        const orgNameResult = validateRequiredText(formData.orgName, "Organization name", 120);
        const ownerPhoneResult = validateRequiredPhone(formData.ownerPhone, "Owner phone");
        const businessTypeResult = validateOptionalText(formData.businessType, "Business type", 80);
        const branchNameResult = validateRequiredText(formData.branchName, "Branch name", 120);
        const cityResult = validateOptionalText(formData.city, "City / area", FORM_LIMITS.cityMax);
        const seatCountResult = parseIntegerField(formData.seatCount, "Total seats", {
            required: true,
            min: 1,
            max: FORM_LIMITS.seatsMax,
        });
        const shiftsResult = validateShiftDrafts(formData.shifts);
        const multiShiftsResult = shiftsResult.ok
            ? validateMultiShiftDrafts(getMultiShiftInputs(), shiftsResult.value)
            : { ok: true as const, value: [] };
        const seatNumberingConfig = seatCountResult.ok
            ? resolveSeatNumberingForCount(formData.seatNumbering as SeatNumberingConfig, seatCountResult.value ?? 0)
            : formData.seatNumbering as SeatNumberingConfig;
        const seatNumberingResult = seatCountResult.ok
            ? generateSeatLabelsForSeatCount(seatCountResult.value, seatNumberingConfig)
            : { ok: true as const, value: [] };

        if (!orgNameResult.ok) errors.orgName = orgNameResult.error;
        if (!ownerPhoneResult.ok) errors.ownerPhone = ownerPhoneResult.error;
        if (!businessTypeResult.ok) errors.businessType = businessTypeResult.error;
        if (!branchNameResult.ok) errors.branchName = branchNameResult.error;
        if (!cityResult.ok) errors.city = cityResult.error;
        if (!seatCountResult.ok) errors.seatCount = seatCountResult.error;
        if (!seatNumberingResult.ok) errors.seatNumbering = seatNumberingResult.error;
        if (!shiftsResult.ok) errors.shifts = shiftsResult.error;
        if (!multiShiftsResult.ok) errors.multiShifts = multiShiftsResult.error;

        if (
            !orgNameResult.ok ||
            !ownerPhoneResult.ok ||
            !businessTypeResult.ok ||
            !branchNameResult.ok ||
            !cityResult.ok ||
            !seatCountResult.ok ||
            !seatNumberingResult.ok ||
            !shiftsResult.ok ||
            !multiShiftsResult.ok
        ) {
            return { errors, values: null };
        }

        return {
            errors,
            values: { orgNameResult, ownerPhoneResult, businessTypeResult, branchNameResult, cityResult, seatCountResult, seatNumberingConfig, shiftsResult, multiShiftsResult },
        };
    };

    const validation = validateForm();
    const seatCountPreviewResult = parseIntegerField(formData.seatCount, "Total seats", {
        required: true,
        min: 1,
        max: FORM_LIMITS.seatsMax,
    });
    const seatCountPreview = seatCountPreviewResult.ok ? seatCountPreviewResult.value : undefined;
    const orgNameError = visibleError("orgName", validation.errors);
    const ownerPhoneError = visibleError("ownerPhone", validation.errors);
    const businessTypeError = visibleError("businessType", validation.errors);
    const branchNameError = visibleError("branchName", validation.errors);
    const cityError = visibleError("city", validation.errors);
    const seatCountError = visibleError("seatCount", validation.errors);
    const seatNumberingError = visibleError("seatNumbering", validation.errors);
    const shiftsError = visibleError("shifts", validation.errors);
    const multiShiftsError = visibleError("multiShifts", validation.errors);

    const handleNext = () => {
        markSubmitted();
        setError(null);
        const result = validateForm();
        if (result.errors.orgName || result.errors.ownerPhone || result.errors.businessType) return;
        resetFieldErrors();
        setStep(2);
    };

    const handleSubmit = async () => {
        markSubmitted();
        setError(null);
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean) || !result.values) return;

        const { orgNameResult, ownerPhoneResult, businessTypeResult, branchNameResult, cityResult, seatCountResult, seatNumberingConfig, shiftsResult, multiShiftsResult } = result.values;
        setLoading(true);

        try {
            const res = await apiClient.post("/onboarding", {
                orgName: orgNameResult.value,
                ownerPhone: ownerPhoneResult.value,
                businessType: businessTypeResult.value,
                branchName: branchNameResult.value,
                city: cityResult.value,
                seatCount: seatCountResult.value,
                seatNumbering: seatNumberingConfig,
                shifts: shiftsResult.value,
                multiShifts: multiShiftsResult.value,
            }) as OnboardingResponse;

            setCreatedBranchId(res.branch.id);
            resetFieldErrors();
            setStep(3);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to complete setup. Please try again.";
            console.error("Setup failed", err);
            setError(message);
        } finally {
            setLoading(false);
        }
    };

    const openImportAssistant = () => {
        if (!createdBranchId) return;
        router.push(`/branch/${createdBranchId}/onboarding/import`);
    };

    const openCleanWorkspace = () => {
        if (!createdBranchId) return;
        router.push(`/branch/${createdBranchId}`);
    };

    const canAddMultiShift = formData.shifts.length >= 2;

    return (
        <div className={cn(entryRootClass, "items-start py-8 sm:items-center")}>
            <div className={cn(entryContentClass, "max-w-5xl")}>
                <div className={cn(entryPanelClass, "grid overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)]")}>
                    <aside className="border-b border-[color:var(--ui-form-section-divider)] bg-[color:var(--ui-form-muted-surface-bg)] p-5 lg:border-b-0 lg:border-r lg:p-6">
                        <div className={cn(entryIconFrameClass, "h-11 w-11")}>
                            <LogoMark className="h-9 w-9" title="Lab Lords logo" />
                        </div>
                        <h1 className={cn(entryTitleClass, "mt-5")}>Set up Lab Lords</h1>
                        <p className={cn(entrySubtitleClass, "mt-3")}>
                            Create the organization, first branch, and preferred starting point for operational records.
                        </p>

                        <div className="mt-8 space-y-3">
                            {stepItems.map(item => {
                                const active = step === item.step;
                                const done = step > item.step;
                                return (
                                    <div key={item.step} className={cn("flex gap-3 p-3", entryInlineInfoClass, active && "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]")}>
                                        <div className={cn(
                                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                                            done
                                                ? "border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] text-[color:var(--ui-badge-success-text)]"
                                                : active
                                                    ? "border-[color:var(--ui-badge-cyan-border)] text-[color:var(--ui-badge-cyan-text)]"
                                                    : "border-[color:var(--ui-form-surface-border)] text-[color:var(--text-muted)]"
                                        )}>
                                            {done ? <CheckCircle2 size={14} /> : item.step}
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold text-[color:var(--text-primary)]">{item.label}</p>
                                            <p className={cn("mt-1 text-xs leading-5", entryMutedTextClass)}>{item.description}</p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </aside>

                    <main className="p-5 sm:p-6 lg:p-8">
                        <div className="mb-6">
                            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--ui-form-accent)]">
                                Step {step} of 3
                            </p>
                            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
                                {stepHeadings[step]}
                            </h2>
                            <p className={cn("mt-2 text-sm leading-6", entryMutedTextClass)}>
                                {stepDescriptions[step]}
                            </p>
                        </div>

                        {step === 1 && (
                            <div className="space-y-5">
                                <div>
                                    <label className={cn("mb-2 block", formLabelClass)}>
                                        Organization Name <span className={formRequiredClass}>*</span>
                                    </label>
                                    <div className="relative">
                                        <Building2 className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} size={18} />
                                        <input
                                            type="text"
                                            name="orgName"
                                            value={formData.orgName}
                                            onChange={handleInputChange}
                                            onBlur={() => markTouched("orgName")}
                                            placeholder="e.g. Apex Study Halls"
                                            maxLength={120}
                                            className={cn(formControlClass, "py-3 pl-10 pr-4", fieldErrorClass(orgNameError))}
                                            autoFocus
                                            {...fieldErrorProps("onboarding-org-name-error", orgNameError)}
                                        />
                                    </div>
                                    <FieldError id="onboarding-org-name-error" error={orgNameError} />
                                </div>

                                <div>
                                    <label className={cn("mb-2 block", formLabelClass)}>
                                        Owner Phone <span className={formRequiredClass}>*</span>
                                    </label>
                                    <div className="relative">
                                        <Phone className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} size={18} />
                                        <input
                                            type="tel"
                                            name="ownerPhone"
                                            value={formData.ownerPhone}
                                            onChange={handleInputChange}
                                            onBlur={() => markTouched("ownerPhone")}
                                            placeholder="+91 98765 43210"
                                            className={cn(formControlClass, "py-3 pl-10 pr-4", fieldErrorClass(ownerPhoneError))}
                                            {...fieldErrorProps("onboarding-owner-phone-error", ownerPhoneError)}
                                        />
                                    </div>
                                    <FieldError id="onboarding-owner-phone-error" error={ownerPhoneError} />
                                </div>

                                <div>
                                    <label className={cn("mb-2 block", formLabelClass)}>
                                        Business Type <span className={formHelpTextClass}>(Optional)</span>
                                    </label>
                                    <select
                                        name="businessType"
                                        value={formData.businessType}
                                        onChange={handleInputChange}
                                        onBlur={() => markTouched("businessType")}
                                        className={cn(formControlClass, "appearance-none px-4 py-3", fieldErrorClass(businessTypeError))}
                                        {...fieldErrorProps("onboarding-business-type-error", businessTypeError)}
                                    >
                                        <option value="" className="bg-[color:var(--ui-form-input-select-bg)] text-[color:var(--ui-form-help)]">Select type...</option>
                                        <option value="Study Hall" className="bg-[color:var(--ui-form-input-select-bg)]">Study Hall</option>
                                        <option value="Library" className="bg-[color:var(--ui-form-input-select-bg)]">Library</option>
                                        <option value="Coaching Center" className="bg-[color:var(--ui-form-input-select-bg)]">Coaching Center</option>
                                        <option value="Tuition" className="bg-[color:var(--ui-form-input-select-bg)]">Tuition</option>
                                        <option value="Other" className="bg-[color:var(--ui-form-input-select-bg)]">Other</option>
                                    </select>
                                    <FieldError id="onboarding-business-type-error" error={businessTypeError} />
                                </div>

                                <AppButton onClick={handleNext} rightIcon={ArrowRight} className="mt-2 w-full justify-center">
                                    Continue
                                </AppButton>
                            </div>
                        )}

                        {step === 2 && (
                            <div className="space-y-5">
                                <div>
                                    <label className={cn("mb-2 block", formLabelClass)}>
                                        Branch Name <span className={formRequiredClass}>*</span>
                                    </label>
                                    <div className="relative">
                                        <MapPin className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} size={18} />
                                        <input
                                            type="text"
                                            name="branchName"
                                            value={formData.branchName}
                                            onChange={handleInputChange}
                                            onBlur={() => markTouched("branchName")}
                                            placeholder="e.g. Main Branch, Downtown"
                                            maxLength={120}
                                            className={cn(formControlClass, "py-3 pl-10 pr-4", fieldErrorClass(branchNameError))}
                                            autoFocus
                                            {...fieldErrorProps("onboarding-branch-name-error", branchNameError)}
                                        />
                                    </div>
                                    <FieldError id="onboarding-branch-name-error" error={branchNameError} />
                                </div>

                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                    <div>
                                        <label className={cn("mb-2 block", formLabelClass)}>
                                            City / Area <span className={formHelpTextClass}>(Optional)</span>
                                        </label>
                                        <input
                                            type="text"
                                            name="city"
                                            value={formData.city}
                                            onChange={handleInputChange}
                                            onBlur={() => markTouched("city")}
                                            placeholder="e.g. New York"
                                            maxLength={FORM_LIMITS.cityMax}
                                            className={cn(formControlClass, "px-4 py-3", fieldErrorClass(cityError))}
                                            {...fieldErrorProps("onboarding-city-error", cityError)}
                                        />
                                        <FieldError id="onboarding-city-error" error={cityError} />
                                    </div>
                                    <div>
                                        <label className={cn("mb-2 block", formLabelClass)}>
                                            Total Seats <span className={formRequiredClass}>*</span>
                                        </label>
                                        <input
                                            type="number"
                                            name="seatCount"
                                            value={formData.seatCount}
                                            onChange={handleInputChange}
                                            onBlur={() => markTouched("seatCount")}
                                            placeholder="e.g. 50"
                                            min="1"
                                            max={FORM_LIMITS.seatsMax}
                                            step="1"
                                            inputMode="numeric"
                                            className={cn(formControlClass, "px-4 py-3", fieldErrorClass(seatCountError))}
                                            {...fieldErrorProps("onboarding-seat-count-error", seatCountError)}
                                        />
                                        <FieldError id="onboarding-seat-count-error" error={seatCountError} />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className={cn("block", formLabelClass)}>Seat numbering</label>
                                    <SeatNumberingBuilder
                                        value={formData.seatNumbering as SeatNumberingConfig}
                                        expectedCount={seatCountPreview}
                                        onChange={(seatNumbering) => {
                                            markTouched("seatNumbering");
                                            setFormData(prev => ({ ...prev, seatNumbering }));
                                            setError(null);
                                        }}
                                        disabled={loading}
                                    />
                                    <FieldError id="onboarding-seat-numbering-error" error={seatNumberingError} />
                                </div>

                                <div className="space-y-5">
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <label className={formLabelClass}>Primary shifts</label>
                                            <button
                                                type="button"
                                                onClick={addShift}
                                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[color:var(--ui-form-accent)] transition-colors hover:text-[color:var(--ui-form-accent-hover)]"
                                            >
                                                <Plus size={13} />
                                                Add primary
                                            </button>
                                        </div>
                                        {formData.shifts.map((shift, idx) => (
                                            <div key={shift.clientId} className={cn("flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:gap-2", formSurfaceClass)}>
                                                <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-12 sm:gap-2">
                                                    <div className="sm:col-span-4">
                                                        <input
                                                            type="text"
                                                            placeholder="Name"
                                                            value={shift.name}
                                                            onChange={(e) => handleShiftChange(idx, "name", e.target.value)}
                                                            className={cn(formInlineControlClass, "py-1 text-sm")}
                                                        />
                                                    </div>
                                                    <div className="sm:col-span-3">
                                                        <input
                                                            type="time"
                                                            value={shift.startTime || ""}
                                                            onChange={(e) => handleShiftChange(idx, "startTime", e.target.value)}
                                                            className={cn(formInlineControlClass, "py-1 text-sm")}
                                                        />
                                                    </div>
                                                    <div className="sm:col-span-3">
                                                        <input
                                                            type="time"
                                                            value={shift.endTime || ""}
                                                            onChange={(e) => handleShiftChange(idx, "endTime", e.target.value)}
                                                            className={cn(formInlineControlClass, "py-1 text-sm")}
                                                        />
                                                    </div>
                                                    <div className="relative sm:col-span-2">
                                                        <span className={cn("absolute left-0 top-1 text-xs", formIconClass)}>Rs.</span>
                                                        <input
                                                            type="number"
                                                            placeholder="Price"
                                                            value={shift.price}
                                                            onChange={(e) => handleShiftChange(idx, "price", e.target.value)}
                                                            min={0}
                                                            max={FORM_LIMITS.moneyMax}
                                                            step={1}
                                                            inputMode="numeric"
                                                            className={cn(formInlineControlClass, "py-1 pl-6 text-sm")}
                                                        />
                                                    </div>
                                                </div>
                                                {formData.shifts.length > 1 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => removeShift(idx)}
                                                        className={cn("self-end transition-colors hover:text-[color:var(--ui-form-error-text)] sm:mt-1", formHelpTextClass)}
                                                        aria-label="Remove shift"
                                                    >
                                                        <X size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                        <FieldError id="onboarding-shifts-error" error={shiftsError} />
                                    </div>

                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <label className={formLabelClass}>Multi-shift bundles</label>
                                                <p className={cn("mt-1 text-xs", formHelpTextClass)}>
                                                    Select 2 or more primary shifts and set the bundle price students will pay.
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={addMultiShift}
                                                disabled={!canAddMultiShift}
                                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[color:var(--ui-form-accent)] transition-colors hover:text-[color:var(--ui-form-accent-hover)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]"
                                            >
                                                <Plus size={13} />
                                                Add bundle
                                            </button>
                                        </div>

                                        {formData.multiShifts.length === 0 ? (
                                            <div className={cn("p-3 text-sm", formSurfaceClass, formHelpTextClass)}>
                                                No multi-shift bundles yet. Add one when a student should get access to multiple primary shifts together.
                                            </div>
                                        ) : (
                                            formData.multiShifts.map((multiShift, idx) => {
                                                const suggestedPrice = getSuggestedMultiShiftPrice(multiShift);
                                                const selectedCount = multiShift.componentShiftIds.length;

                                                return (
                                                    <div key={multiShift.clientId} className={cn("space-y-3 p-3", formSurfaceClass)}>
                                                        <div className="flex items-start gap-3">
                                                            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]">
                                                                <Layers size={15} />
                                                            </div>
                                                            <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-12 sm:gap-2">
                                                                <div className="sm:col-span-5">
                                                                    <input
                                                                        type="text"
                                                                        placeholder="Bundle name"
                                                                        value={multiShift.name}
                                                                        onChange={(e) => handleMultiShiftChange(idx, "name", e.target.value)}
                                                                        className={cn(formInlineControlClass, "py-1 text-sm")}
                                                                    />
                                                                </div>
                                                                <div className="relative sm:col-span-3">
                                                                    <span className={cn("absolute left-0 top-1 text-xs", formIconClass)}>Rs.</span>
                                                                    <input
                                                                        type="number"
                                                                        placeholder="Price"
                                                                        value={multiShift.price}
                                                                        onChange={(e) => handleMultiShiftChange(idx, "price", e.target.value)}
                                                                        min={0}
                                                                        max={FORM_LIMITS.moneyMax}
                                                                        step={1}
                                                                        inputMode="numeric"
                                                                        className={cn(formInlineControlClass, "py-1 pl-6 text-sm")}
                                                                    />
                                                                </div>
                                                                <div className="flex flex-col gap-1 sm:col-span-4 sm:items-end">
                                                                    <span className={cn("text-xs font-semibold", formHelpTextClass)}>
                                                                        Selected total {formatPrice(suggestedPrice)}
                                                                    </span>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => applySuggestedMultiShiftPrice(idx)}
                                                                        className="text-xs font-semibold text-[color:var(--ui-form-accent)] transition-colors hover:text-[color:var(--ui-form-accent-hover)]"
                                                                    >
                                                                        Use total
                                                                    </button>
                                                                </div>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={() => removeMultiShift(idx)}
                                                                className={cn("transition-colors hover:text-[color:var(--ui-form-error-text)]", formHelpTextClass)}
                                                                aria-label={`Remove ${multiShift.name || "multi-shift"}`}
                                                            >
                                                                <X size={14} />
                                                            </button>
                                                        </div>

                                                        <div className="flex flex-wrap gap-2">
                                                            {formData.shifts.map((shift, shiftIndex) => {
                                                                const selected = multiShift.componentShiftIds.includes(shift.clientId);
                                                                return (
                                                                    <button
                                                                        key={shift.clientId}
                                                                        type="button"
                                                                        onClick={() => toggleMultiShiftComponent(idx, shift.clientId)}
                                                                        className={cn(
                                                                            "flex min-w-[9rem] items-center justify-between gap-2 rounded-[var(--ui-radius-control)] border px-2.5 py-2 text-left text-xs transition-colors",
                                                                            selected
                                                                                ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                                                                                : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] text-[color:var(--ui-form-help)] hover:border-[color:var(--ui-form-input-border)]"
                                                                        )}
                                                                        aria-pressed={selected}
                                                                    >
                                                                        <span className="min-w-0">
                                                                            <span className="block truncate font-semibold">
                                                                                {shift.name || `Shift ${shiftIndex + 1}`}
                                                                            </span>
                                                                            <span className="mt-0.5 block truncate font-mono text-[10px] opacity-75">
                                                                                {shift.startTime || "--:--"} - {shift.endTime || "--:--"} / {formatPrice(numericDraftPrice(shift.price))}
                                                                            </span>
                                                                        </span>
                                                                        {selected && <CheckCircle2 size={14} className="shrink-0" />}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>

                                                        <p className={cn("text-xs", selectedCount >= 2 ? formHelpTextClass : "text-[color:var(--ui-form-error-text)]")}>
                                                            {selectedCount} primary shift{selectedCount === 1 ? "" : "s"} selected.
                                                        </p>
                                                    </div>
                                                );
                                            })
                                        )}
                                        <FieldError id="onboarding-multi-shifts-error" error={multiShiftsError} />
                                    </div>
                                </div>

                                <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
                                    <AppButton
                                        variant="quiet"
                                        icon={ArrowLeft}
                                        onClick={() => {
                                            resetFieldErrors();
                                            setStep(1);
                                        }}
                                        disabled={loading}
                                    >
                                        Back
                                    </AppButton>
                                    <AppButton
                                        onClick={handleSubmit}
                                        disabled={loading}
                                        isLoading={loading}
                                        rightIcon={loading ? undefined : ArrowRight}
                                        className="sm:min-w-40"
                                    >
                                        {loading ? "Setting up..." : "Create branch"}
                                    </AppButton>
                                </div>
                            </div>
                        )}

                        {step === 3 && (
                            <div className="space-y-5">
                                <div className={cn("flex items-start gap-3 p-4", formSuccessBannerClass)}>
                                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                                    <div>
                                        <p className="text-sm font-semibold">Organization and branch created</p>
                                        <p className="mt-1 text-sm leading-6">
                                            Your branch structure is ready. Select the preferred starting point for operational records.
                                        </p>
                                    </div>
                                </div>

                                <div className="grid gap-4 md:grid-cols-2">
                                    <button
                                        type="button"
                                        onClick={openImportAssistant}
                                        disabled={!createdBranchId}
                                        className={cn(
                                            "group flex h-full flex-col items-start gap-4 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                                            formSurfaceClass,
                                            formSurfaceHoverClass
                                        )}
                                    >
                                        <span className={cn(entryIconFrameClass, "h-11 w-11")}>
                                            <UploadCloud size={20} />
                                        </span>
                                        <span>
                                            <span className="block text-base font-semibold text-[color:var(--text-primary)]">Import existing records</span>
                                            <span className={cn("mt-2 block text-sm leading-6", entryMutedTextClass)}>
                                                Bring students, seats, shifts, allocations, and payment records from a spreadsheet or pasted table.
                                            </span>
                                        </span>
                                        <span className="mt-auto inline-flex items-center gap-2 text-sm font-semibold text-[color:var(--ui-form-accent)]">
                                            Open Import Assistant
                                            <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={openCleanWorkspace}
                                        disabled={!createdBranchId}
                                        className={cn(
                                            "group flex h-full flex-col items-start gap-4 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                                            formSurfaceClass,
                                            formSurfaceHoverClass
                                        )}
                                    >
                                        <span className={cn(entryIconFrameClass, "h-11 w-11")}>
                                            <LayoutDashboard size={20} />
                                        </span>
                                        <span>
                                            <span className="block text-base font-semibold text-[color:var(--text-primary)]">Begin with a clean workspace</span>
                                            <span className={cn("mt-2 block text-sm leading-6", entryMutedTextClass)}>
                                                Open the branch with configured seats and shifts, then add records manually as operations begin.
                                            </span>
                                        </span>
                                        <span className="mt-auto inline-flex items-center gap-2 text-sm font-semibold text-[color:var(--ui-form-accent)]">
                                            Go to branch dashboard
                                            <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                                        </span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {error && (
                            <div className={cn("mt-5 p-3 text-sm", formErrorBannerClass)}>
                                {error}
                            </div>
                        )}
                    </main>
                </div>
            </div>
        </div>
    );
}
