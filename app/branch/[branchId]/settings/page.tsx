"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
    AlertCircle,
    Armchair,
    Bot,
    Building2,
    Calendar,
    CalendarClock,
    Clock,
    CreditCard,
    GitBranch,
    Hash,
    IndianRupee,
    MapPin,
    MessageSquare,
    Phone,
    Shield,
    Users,
} from "lucide-react";
import { AppButton, PageLoadingSkeleton } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import {
    ReadOnlyRow,
    SegmentedControl,
    SettingsCard,
    SettingsEmptyState,
    SettingsField,
    SettingsInput,
    SettingsPanel,
    SettingsSaveBar,
    SettingsSelect,
    SettingsSubtleText,
    SettingsTextArea,
    SettingsToggle,
    SettingsWorkspace,
} from "@/components/settings/SettingsWorkspace";
import { useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { cn } from "@/lib/utils";
import { formWarningBannerClass } from "@/components/ui/formSurface";
import type { BranchAccess } from "@/types";
import {
    pageErrorIconClass,
    pageErrorStateClass,
    pageMutedTextClass,
} from "@/components/ui/pageSurface";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalText,
    validateOptionalTime,
    validateRequiredPhone,
    validateRequiredText,
} from "@/lib/formValidation";

interface ActiveShift {
    id: string;
    name: string;
    startTime: string | null;
    endTime: string | null;
    price: number;
    isReserved: boolean;
}

interface StaffMember {
    id: string;
    role: string;
    user?: { id: string; name: string | null; email: string } | null;
}

interface BranchData {
    id: string;
    name: string;
    city: string | null;
    address: string | null;
    contactPhone: string | null;
    openingTime: string | null;
    closingTime: string | null;
    defaultFee: number | null;
    defaultAdmissionFee: number | null;
    defaultMessageLanguage: "en" | "hi";
    reminderTone: "polite" | "friendly" | "firm";
    aiEnabled: boolean;
    createdAt: string;
    lastDataChange: string;
    organization?: { id: string; name: string; ownerId: string } | null;
    _count?: {
        seats: number;
        students: number;
        shifts: number;
        payments: number;
        staff: number;
    };
    shifts?: ActiveShift[];
    staff?: StaffMember[];
}

type BranchForm = Pick<
    BranchData,
    | "name"
    | "city"
    | "address"
    | "contactPhone"
    | "openingTime"
    | "closingTime"
    | "defaultFee"
    | "defaultAdmissionFee"
    | "defaultMessageLanguage"
    | "reminderTone"
    | "aiEnabled"
>;

const SECTIONS = [
    { id: "profile", label: "Profile", icon: Building2 },
    { id: "defaults", label: "Student Defaults", icon: IndianRupee },
    { id: "communication", label: "Communication", icon: MessageSquare },
    { id: "ai", label: "AI", icon: Bot },
    { id: "access", label: "Access", icon: Shield },
    { id: "billing", label: "Billing", icon: CreditCard },
    { id: "system", label: "System Info", icon: Hash },
];

function toForm(branch: BranchData): BranchForm {
    return {
        name: branch.name ?? "",
        city: branch.city ?? "",
        address: branch.address ?? "",
        contactPhone: branch.contactPhone ?? "",
        openingTime: branch.openingTime ?? "",
        closingTime: branch.closingTime ?? "",
        defaultFee: branch.defaultFee ?? 0,
        defaultAdmissionFee: branch.defaultAdmissionFee ?? 0,
        defaultMessageLanguage: branch.defaultMessageLanguage ?? "en",
        reminderTone: branch.reminderTone ?? "polite",
        aiEnabled: branch.aiEnabled ?? true,
    };
}

export default function BranchSettingsPage({ params }: { params: Promise<{ branchId: string }> }) {
    const { branchId } = use(params);

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.settings}>
            {access => <BranchSettingsContent branchId={branchId} access={access} />}
        </BranchAccessGuard>
    );
}

interface BranchBillingSummary {
    organizationId: string;
    branchStatus: string;
    inheritedPlan: string;
    billingState: string;
    accessMode: "FULL" | "WARNING" | "READ_ONLY";
    billingUrl: string;
}

function BranchSettingsContent({ branchId, access }: { branchId: string; access: BranchAccess }) {
    const router = useRouter();
    const hasAiAccess = access.entitlements.includes("AI_ACCESS");

    const [branch, setBranch] = useState<BranchData | null>(null);
    const [billingSummary, setBillingSummary] = useState<BranchBillingSummary | null>(null);
    const [form, setForm] = useState<BranchForm | null>(null);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [activeSection, setActiveSection] = useState("profile");
    const [saving, setSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
    const [saveError, setSaveError] = useState("");
    const { markTouched, markSubmitted, resetFieldErrors, visibleError } = useInlineFieldErrors<
        "name" | "city" | "address" | "contactPhone" | "openingTime" | "closingTime" | "operatingHours" | "defaultFee" | "defaultAdmissionFee"
    >();

    useEffect(() => {
        async function load() {
            try {
                const [res, billingRes] = await Promise.all([
                    fetch(`/api/branches/${branchId}`),
                    fetch(`/api/branches/${branchId}/billing`),
                ]);
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || "Failed to load branch settings");
                }
                const data = await res.json();
                setBranch(data);
                setForm(toForm(data));
                if (billingRes.ok) setBillingSummary(await billingRes.json());
                resetFieldErrors();
            } catch (err) {
                setFetchError(err instanceof Error ? err.message : "Something went wrong.");
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [branchId, resetFieldErrors]);

    const hasChanges = useMemo(() => {
        if (!branch || !form) return false;
        return JSON.stringify(form) !== JSON.stringify(toForm(branch));
    }, [branch, form]);

    const updateForm = <K extends keyof BranchForm>(key: K, value: BranchForm[K]) => {
        setForm(prev => prev ? { ...prev, [key]: value } : prev);
        if (saveStatus !== "idle") setSaveStatus("idle");
    };

    const reset = () => {
        if (!branch) return;
        setForm(toForm(branch));
        setSaveStatus("idle");
        setSaveError("");
        resetFieldErrors();
    };

    const validateForm = () => {
        const errors: Partial<Record<"name" | "city" | "address" | "contactPhone" | "openingTime" | "closingTime" | "operatingHours" | "defaultFee" | "defaultAdmissionFee", string>> = {};
        if (!form) return { errors, values: null };
        const nameResult = validateRequiredText(form.name, "Branch name", 120);
        const cityResult = validateOptionalText(form.city, "City", FORM_LIMITS.cityMax);
        const addressResult = validateOptionalText(form.address, "Address", 240);
        const contactPhoneResult = validateRequiredPhone(form.contactPhone, "Contact phone");
        const openingTimeResult = validateOptionalTime(form.openingTime, "Opening time");
        const closingTimeResult = validateOptionalTime(form.closingTime, "Closing time");
        if (!nameResult.ok) errors.name = nameResult.error;
        if (!cityResult.ok) errors.city = cityResult.error;
        if (!addressResult.ok) errors.address = addressResult.error;
        if (!contactPhoneResult.ok) errors.contactPhone = contactPhoneResult.error;
        if (!openingTimeResult.ok) errors.openingTime = openingTimeResult.error;
        if (!closingTimeResult.ok) errors.closingTime = closingTimeResult.error;
        const openingTimeValue = openingTimeResult.ok ? openingTimeResult.value : null;
        const closingTimeValue = closingTimeResult.ok ? closingTimeResult.value : null;
        if ((openingTimeValue && !closingTimeValue) || (!openingTimeValue && closingTimeValue)) {
            errors.operatingHours = "Operating hours must have both opening and closing time, or neither.";
        }
        const defaultFeeResult = parseIntegerField(form.defaultFee, "Default monthly fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        const defaultAdmissionFeeResult = parseIntegerField(form.defaultAdmissionFee, "Default admission fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!defaultFeeResult.ok) errors.defaultFee = defaultFeeResult.error;
        if (!defaultAdmissionFeeResult.ok) errors.defaultAdmissionFee = defaultAdmissionFeeResult.error;
        if (
            !nameResult.ok ||
            !cityResult.ok ||
            !addressResult.ok ||
            !contactPhoneResult.ok ||
            !openingTimeResult.ok ||
            !closingTimeResult.ok ||
            !!errors.operatingHours ||
            !defaultFeeResult.ok ||
            !defaultAdmissionFeeResult.ok
        ) return { errors, values: null };
        return {
            errors,
            values: {
                nameResult,
                cityResult,
                addressResult,
                contactPhoneResult,
                openingTimeResult,
                closingTimeResult,
                defaultFeeResult,
                defaultAdmissionFeeResult,
            },
        };
    };

    const validation = validateForm();
    const nameError = visibleError("name", validation.errors);
    const cityError = visibleError("city", validation.errors);
    const addressError = visibleError("address", validation.errors);
    const contactPhoneError = visibleError("contactPhone", validation.errors);
    const openingTimeError = visibleError("openingTime", validation.errors);
    const closingTimeError = visibleError("closingTime", validation.errors);
    const operatingHoursError = visibleError("operatingHours", validation.errors);
    const defaultFeeError = visibleError("defaultFee", validation.errors);
    const defaultAdmissionFeeError = visibleError("defaultAdmissionFee", validation.errors);

    const save = async () => {
        if (!form) return;
        markSubmitted();
        setSaveError("");
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean) || !result.values) {
            if (saveStatus === "error") setSaveStatus("idle");
            return;
        }
        const {
            nameResult,
            cityResult,
            addressResult,
            contactPhoneResult,
            openingTimeResult,
            closingTimeResult,
            defaultFeeResult,
            defaultAdmissionFeeResult,
        } = result.values;
        setSaving(true);
        setSaveStatus("idle");
        setSaveError("");
        try {
            const res = await fetch(`/api/branches/${branchId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...form,
                    name: nameResult.value,
                    city: cityResult.value ?? null,
                    address: addressResult.value ?? null,
                    contactPhone: contactPhoneResult.value,
                    openingTime: openingTimeResult.value,
                    closingTime: closingTimeResult.value,
                    defaultFee: defaultFeeResult.value ?? 0,
                    defaultAdmissionFee: defaultAdmissionFeeResult.value ?? 0,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || "Failed to save branch settings");
            }
            const updated = await res.json();
            setBranch(updated);
            setForm(toForm(updated));
            resetFieldErrors();
            setSaveStatus("success");
            setTimeout(() => setSaveStatus("idle"), 3000);
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : "Save failed.");
            setSaveStatus("error");
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <PageLoadingSkeleton label="Loading branch settings" variant="settings" maxWidth="content" />;
    }

    if (fetchError || !branch || !form) {
        return (
            <div className={pageErrorStateClass}>
                <AlertCircle className={pageErrorIconClass} />
                <p className={pageMutedTextClass}>{fetchError || "Branch not found."}</p>
                <AppButton variant="secondary" onClick={() => router.back()}>Back</AppButton>
            </div>
        );
    }

    const counts = branch._count ?? { seats: 0, students: 0, shifts: 0, payments: 0, staff: 0 };
    const shifts = branch.shifts ?? [];
    const staff = branch.staff ?? [];

    return (
        <>
            <SettingsWorkspace
                title="Branch Settings"
                subtitle="Configure the branch profile, billing defaults, reminders, AI, and access overview."
                sections={SECTIONS}
                activeSection={activeSection}
                onSectionChange={setActiveSection}
            >
                <SettingsPanel id="profile" title="Profile" description="Operational identity and public branch contact details." icon={Building2}>
                    <SettingsField label="Branch name" error={nameError} errorId="branch-name-error">
                        <SettingsInput value={form.name} onChange={e => updateForm("name", e.target.value)} onBlur={() => markTouched("name")} placeholder="Main Branch" error={nameError} errorId="branch-name-error" />
                    </SettingsField>
                    <SettingsField label="City" error={cityError} errorId="branch-city-error">
                        <SettingsInput value={form.city ?? ""} onChange={e => updateForm("city", e.target.value)} onBlur={() => markTouched("city")} placeholder="Delhi" error={cityError} errorId="branch-city-error" />
                    </SettingsField>
                    <SettingsField label="Address" error={addressError} errorId="branch-address-error">
                        <SettingsTextArea value={form.address ?? ""} onChange={e => updateForm("address", e.target.value)} onBlur={() => markTouched("address")} placeholder="Branch address" error={addressError} errorId="branch-address-error" />
                    </SettingsField>
                    <SettingsField label="Contact phone" description="Required phone number for branch operations." error={contactPhoneError} errorId="branch-contact-phone-error">
                        <SettingsInput value={form.contactPhone ?? ""} onChange={e => updateForm("contactPhone", e.target.value)} onBlur={() => markTouched("contactPhone")} placeholder="+91 98765 43210" error={contactPhoneError} errorId="branch-contact-phone-error" />
                    </SettingsField>
                    <SettingsField label="Operating hours" description="Stored as the branch default opening and closing window." error={openingTimeError || closingTimeError || operatingHoursError} errorId="branch-operating-hours-error">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <SettingsInput type="time" value={form.openingTime ?? ""} onChange={e => updateForm("openingTime", e.target.value)} onBlur={() => { markTouched("openingTime"); markTouched("operatingHours"); }} error={openingTimeError || operatingHoursError} errorId="branch-operating-hours-error" />
                            <SettingsInput type="time" value={form.closingTime ?? ""} onChange={e => updateForm("closingTime", e.target.value)} onBlur={() => { markTouched("closingTime"); markTouched("operatingHours"); }} error={closingTimeError || operatingHoursError} errorId="branch-operating-hours-error" />
                        </div>
                    </SettingsField>
                </SettingsPanel>

                <SettingsPanel id="defaults" title="Student Defaults" description="Defaults applied when creating new students in this branch." icon={IndianRupee}>
                    <SettingsField label="Default monthly fee" description="Used when a new student has no manual fee or shift-linked fee." error={defaultFeeError} errorId="branch-default-fee-error">
                        <SettingsInput type="number" min={0} value={form.defaultFee ?? 0} onChange={e => updateForm("defaultFee", Number(e.target.value))} onBlur={() => markTouched("defaultFee")} error={defaultFeeError} errorId="branch-default-fee-error" />
                    </SettingsField>
                    <SettingsField label="Default admission fee" description="Pre-fills new student admission fee and is used if no admission fee is supplied." error={defaultAdmissionFeeError} errorId="branch-default-admission-fee-error">
                        <SettingsInput type="number" min={0} value={form.defaultAdmissionFee ?? 0} onChange={e => updateForm("defaultAdmissionFee", Number(e.target.value))} onBlur={() => markTouched("defaultAdmissionFee")} error={defaultAdmissionFeeError} errorId="branch-default-admission-fee-error" />
                    </SettingsField>
                    <ReadOnlyRow label="Active students" value={<span className="inline-flex items-center gap-2"><Users size={14} />{counts.students}</span>} />
                    <ReadOnlyRow label="Seat capacity" value={<span className="inline-flex items-center gap-2"><Armchair size={14} />{counts.seats} seats</span>} />
                </SettingsPanel>

                <SettingsPanel id="communication" title="Communication" description="Defaults for manually copied payment reminder drafts." icon={MessageSquare}>
                    <SettingsField label="Default message language">
                        <SegmentedControl
                            value={form.defaultMessageLanguage}
                            onChange={value => updateForm("defaultMessageLanguage", value)}
                            options={[
                                { value: "en", label: "English" },
                                { value: "hi", label: "Hindi" },
                            ]}
                        />
                    </SettingsField>
                    <SettingsField label="Reminder tone">
                        <SettingsSelect value={form.reminderTone} onChange={e => updateForm("reminderTone", e.target.value as BranchForm["reminderTone"])}>
                            <option value="polite">Polite</option>
                            <option value="friendly">Friendly</option>
                            <option value="firm">Firm</option>
                        </SettingsSelect>
                    </SettingsField>
                    <ReadOnlyRow label="Payments due" value={counts.payments} />
                </SettingsPanel>

                <SettingsPanel id="ai" title="AI" description="Control whether this branch can generate AI reports." icon={Bot}>
                    <SettingsField label="AI reports">
                        <SettingsToggle
                            checked={form.aiEnabled}
                            onChange={value => updateForm("aiEnabled", value)}
                            disabled={!hasAiAccess}
                            label={!hasAiAccess ? "AI requires the Standard plan" : form.aiEnabled ? "AI generation enabled" : "AI generation disabled"}
                            description={!hasAiAccess ? "Upgrade the organization to Standard to enable AI reports and message drafting." : form.aiEnabled ? "Branch AI reports can run using the current branch data." : "AI report generation will return a disabled state for this branch."}
                        />
                    </SettingsField>
                    {hasAiAccess && !form.aiEnabled && (
                        <div className="px-5 py-4">
                            <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)}>
                                AI is off for this branch. Existing reports remain visible, but new generation is blocked.
                            </div>
                        </div>
                    )}
                </SettingsPanel>

                <SettingsPanel id="access" title="Access" description="Team summary for this branch." icon={Shield}>
                    <ReadOnlyRow label="Staff members" value={counts.staff} />
                    <div className="grid gap-2 px-5 py-4 md:grid-cols-2">
                        {staff.map(member => (
                            <SettingsCard key={member.id}>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="truncate text-sm font-medium text-[color:var(--text-primary)]">{member.user?.name || member.user?.email || member.user?.id}</span>
                                    <Badge variant="cyan">{member.role}</Badge>
                                </div>
                                <SettingsSubtleText className="mt-1 truncate">{member.user?.email || "No email"}</SettingsSubtleText>
                            </SettingsCard>
                        ))}
                        {staff.length === 0 && (
                            <SettingsEmptyState>No staff records found.</SettingsEmptyState>
                        )}
                    </div>
                    <div className="px-5 pb-4">
                        <AppButton variant="secondary" size="sm" onClick={() => router.push(`/branch/${branchId}/staff`)}>
                            Manage staff
                        </AppButton>
                    </div>
                </SettingsPanel>

                <SettingsPanel id="billing" title="Billing" description="This branch inherits its organization's billing plan." icon={CreditCard}>
                    <ReadOnlyRow label="Inherited plan" value={billingSummary?.inheritedPlan ?? "Loading"} />
                    <ReadOnlyRow label="Branch billing status" value={billingSummary?.branchStatus ?? "Loading"} />
                    <ReadOnlyRow label="Billing state" value={billingSummary?.billingState ?? "Loading"} />
                    <ReadOnlyRow label="Access mode" value={billingSummary?.accessMode ?? "Loading"} />
                    <div className="px-5 py-4">
                        <AppButton
                            variant="secondary"
                            size="sm"
                            disabled={!billingSummary}
                            onClick={() => billingSummary && router.push(billingSummary.billingUrl)}
                        >
                            Open organization billing
                        </AppButton>
                    </div>
                </SettingsPanel>

                <SettingsPanel id="system" title="System Info" description="Read-only branch metadata and active shift summary." icon={Hash}>
                    <ReadOnlyRow label="Organization" value={<span className="inline-flex items-center gap-2"><GitBranch size={14} />{branch.organization?.name || "N/A"}</span>} />
                    <ReadOnlyRow label="Branch ID" value={<span className="font-mono">{branch.id}</span>} />
                    <ReadOnlyRow label="Created" value={<span className="inline-flex items-center gap-2"><Calendar size={14} />{format(new Date(branch.createdAt), "PPP")}</span>} />
                    <ReadOnlyRow label="Last data change" value={format(new Date(branch.lastDataChange), "PPp")} />
                    <div className="px-5 py-4">
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[color:var(--text-primary)]">
                            <CalendarClock size={15} className="text-[color:var(--ui-form-accent)]" />
                            Active shifts
                        </div>
                        <div className="grid gap-2 md:grid-cols-2">
                            {shifts.length === 0 ? (
                                <SettingsEmptyState>No active shifts.</SettingsEmptyState>
                            ) : shifts.map(shift => (
                                <SettingsCard key={shift.id}>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm font-medium text-[color:var(--text-primary)]">{shift.name}</span>
                                        <span className="text-xs text-[color:var(--ui-tone-success-text)]">Rs {shift.price.toLocaleString("en-IN")}</span>
                                    </div>
                                    <p className="mt-1 flex items-center gap-1 text-xs text-[color:var(--text-muted)]">
                                        <Clock size={11} />
                                        {shift.startTime && shift.endTime ? `${shift.startTime} - ${shift.endTime}` : "Flexible"}
                                        {shift.isReserved ? " / Reserved" : ""}
                                    </p>
                                </SettingsCard>
                            ))}
                        </div>
                    </div>
                    <ReadOnlyRow label="Location" value={<span className="inline-flex items-center gap-2"><MapPin size={14} />{branch.city || "Not set"}</span>} />
                    <ReadOnlyRow label="Contact" value={<span className="inline-flex items-center gap-2"><Phone size={14} />{branch.contactPhone || "Not set"}</span>} />
                </SettingsPanel>
            </SettingsWorkspace>

            <SettingsSaveBar
                visible={hasChanges}
                saving={saving}
                status={saveStatus}
                error={saveError}
                onSave={save}
                onReset={reset}
            />
        </>
    );
}
