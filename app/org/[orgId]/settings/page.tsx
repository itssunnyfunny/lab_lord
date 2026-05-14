"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
    AlertCircle,
    Briefcase,
    Building2,
    Calendar,
    CheckCircle2,
    Clock,
    CreditCard,
    GitBranch,
    Hash,
    Mail,
    MapPin,
    Phone,
    Shield,
    Sparkles,
    XCircle,
} from "lucide-react";
import { AppButton, PageLoadingSkeleton } from "@/components/ui";
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
    SettingsWorkspace,
} from "@/components/settings/SettingsWorkspace";
import { useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import {
    pageErrorIconClass,
    pageErrorStateClass,
    pageMutedTextClass,
} from "@/components/ui/pageSurface";
import {
    formSuccessBannerClass,
    formWarningBannerClass,
} from "@/components/ui/formSurface";
import {
    parseIntegerField,
    validateOptionalEmail,
    validateOptionalText,
    validateRequiredPhone,
    validateRequiredText,
} from "@/lib/formValidation";
import { billing, type BillingCheckoutPayload, type BillingOverview, type BillingPlanDto, type OrganizationSubscriptionDto } from "@/lib/api/billing";
import type { BillingPlanId } from "@/lib/billingPlans";
import { cn } from "@/lib/utils";

type RazorpayHandlerResponse = {
    razorpay_payment_id: string;
    razorpay_subscription_id?: string;
    razorpay_signature: string;
};

type RazorpayFailureResponse = {
    error?: {
        code?: string;
        description?: string;
        reason?: string;
        metadata?: Record<string, string | undefined>;
    };
};

type RazorpayInstance = {
    open: () => void;
    on: (event: "payment.failed", handler: (response: RazorpayFailureResponse) => void) => void;
};

type RazorpayOptions = {
    key: string;
    name: string;
    description: string;
    subscription_id: string;
    prefill: BillingCheckoutPayload["prefill"];
    notes: BillingCheckoutPayload["notes"];
    theme: { color: string };
    retry: { enabled: boolean };
    modal: {
        confirm_close: boolean;
        ondismiss: () => void | Promise<void>;
    };
    handler: (response: RazorpayHandlerResponse) => void | Promise<void>;
};

declare global {
    interface Window {
        Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
    }
}

interface BranchSummary {
    id: string;
    name: string;
    city: string | null;
    createdAt: string;
}

interface OrgDetails {
    id: string;
    name: string;
    businessType: string | null;
    legalName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    address: string | null;
    timezone: string;
    currency: string;
    weekStartsOn: 0 | 1;
    paymentGraceDays: number;
    ownerId: string;
    owner?: { id: string; name: string | null; email: string };
    subscription?: OrganizationSubscriptionDto | null;
    createdAt: string;
    branches: BranchSummary[];
    _count: { branches: number };
}

type OrgForm = Pick<
    OrgDetails,
    | "name"
    | "businessType"
    | "legalName"
    | "contactEmail"
    | "contactPhone"
    | "address"
    | "timezone"
    | "currency"
    | "weekStartsOn"
    | "paymentGraceDays"
>;

const SECTIONS = [
    { id: "profile", label: "Business Profile", icon: Building2 },
    { id: "contact", label: "Contact", icon: MapPin },
    { id: "regional", label: "Regional Defaults", icon: Clock },
    { id: "branches", label: "Branches", icon: GitBranch },
    { id: "billing", label: "Billing", icon: CreditCard },
    { id: "system", label: "System Info", icon: Shield },
];

const BUSINESS_TYPES = ["Study Hall", "Library", "Coaching Center", "Tuition Class", "Other"];

let razorpayCheckoutScriptPromise: Promise<void> | null = null;

function loadRazorpayCheckoutScript() {
    if (typeof window === "undefined") {
        return Promise.reject(new Error("Razorpay Checkout can only run in the browser"));
    }
    if (window.Razorpay) return Promise.resolve();
    if (razorpayCheckoutScriptPromise) return razorpayCheckoutScriptPromise;

    razorpayCheckoutScriptPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>("script[data-razorpay-checkout]");
        if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error("Failed to load Razorpay Checkout")), { once: true });
            return;
        }

        const script = document.createElement("script");
        script.src = "https://checkout.razorpay.com/v1/checkout.js";
        script.async = true;
        script.dataset.razorpayCheckout = "true";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Razorpay Checkout"));
        document.body.appendChild(script);
    });

    return razorpayCheckoutScriptPromise;
}

function toForm(org: OrgDetails): OrgForm {
    return {
        name: org.name ?? "",
        businessType: org.businessType ?? "",
        legalName: org.legalName ?? "",
        contactEmail: org.contactEmail ?? "",
        contactPhone: org.contactPhone ?? "",
        address: org.address ?? "",
        timezone: org.timezone ?? "Asia/Kolkata",
        currency: org.currency ?? "INR",
        weekStartsOn: org.weekStartsOn ?? 1,
        paymentGraceDays: org.paymentGraceDays ?? 0,
    };
}

export default function OrgSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
    const { orgId } = use(params);
    const router = useRouter();

    const [org, setOrg] = useState<OrgDetails | null>(null);
    const [form, setForm] = useState<OrgForm | null>(null);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [activeSection, setActiveSection] = useState("profile");
    const [saving, setSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
    const [saveError, setSaveError] = useState("");
    const [billingOverview, setBillingOverview] = useState<BillingOverview | null>(null);
    const [billingLoading, setBillingLoading] = useState(true);
    const [billingAction, setBillingAction] = useState<BillingPlanId | null>(null);
    const [billingNotice, setBillingNotice] = useState<{ tone: "success" | "warning" | "error"; message: string } | null>(null);
    const { markTouched, markSubmitted, resetFieldErrors, visibleError } = useInlineFieldErrors<
        "name" | "businessType" | "legalName" | "contactEmail" | "contactPhone" | "address" | "paymentGraceDays"
    >();

    const loadBilling = useCallback(async () => {
        setBillingLoading(true);
        try {
            const overview = await billing.getOverview(orgId);
            setBillingOverview(overview);
            setBillingNotice(prev => prev?.tone === "error" ? null : prev);
        } catch (err) {
            setBillingNotice({
                tone: "error",
                message: err instanceof Error ? err.message : "Failed to load billing plans.",
            });
        } finally {
            setBillingLoading(false);
        }
    }, [orgId]);

    useEffect(() => {
        async function load() {
            try {
                const res = await fetch(`/api/organizations/${orgId}`);
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || "Failed to load organization settings");
                }
                const data = await res.json();
                setOrg(data);
                setForm(toForm(data));
                resetFieldErrors();
                await loadBilling();
            } catch (err) {
                setFetchError(err instanceof Error ? err.message : "Something went wrong.");
                setBillingLoading(false);
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [orgId, loadBilling, resetFieldErrors]);

    const hasChanges = useMemo(() => {
        if (!org || !form) return false;
        return JSON.stringify(form) !== JSON.stringify(toForm(org));
    }, [org, form]);

    const updateForm = <K extends keyof OrgForm>(key: K, value: OrgForm[K]) => {
        setForm(prev => prev ? { ...prev, [key]: value } : prev);
        if (saveStatus !== "idle") setSaveStatus("idle");
    };

    const reset = () => {
        if (!org) return;
        setForm(toForm(org));
        setSaveStatus("idle");
        setSaveError("");
        resetFieldErrors();
    };

    const startSubscription = async (planId: BillingPlanId) => {
        setBillingAction(planId);
        setBillingNotice(null);

        try {
            const checkout = await billing.createSubscription(orgId, planId);
            setBillingOverview(prev => prev ? { ...prev, current: checkout.subscription } : prev);

            await loadRazorpayCheckoutScript();
            if (!window.Razorpay) throw new Error("Razorpay Checkout did not load");

            let completed = false;
            const razorpay = new window.Razorpay({
                key: checkout.keyId,
                name: checkout.name,
                description: checkout.description,
                subscription_id: checkout.subscriptionId,
                prefill: checkout.prefill,
                notes: checkout.notes,
                theme: { color: "#22c55e" },
                retry: { enabled: true },
                modal: {
                    confirm_close: true,
                    ondismiss: async () => {
                        if (completed) return;
                        setBillingNotice({
                            tone: "warning",
                            message: "Checkout closed. The subscription stays pending until Razorpay confirms a final state.",
                        });
                        setBillingAction(null);
                        await loadBilling();
                    },
                },
                handler: async (response) => {
                    completed = true;
                    try {
                        const result = await billing.verifySubscription(orgId, {
                            razorpay_subscription_id: response.razorpay_subscription_id ?? checkout.subscriptionId,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature,
                        });
                        setBillingOverview(prev => prev ? { ...prev, current: result.subscription } : prev);
                        setBillingNotice({
                            tone: result.subscription.status === "ACTIVE" ? "success" : "warning",
                            message: result.subscription.status === "ACTIVE"
                                ? "Subscription is active."
                                : "Subscription authorization is verified. Razorpay may finish activation shortly.",
                        });
                        await loadBilling();
                    } catch (err) {
                        setBillingNotice({
                            tone: "error",
                            message: err instanceof Error ? err.message : "Razorpay verification failed.",
                        });
                    } finally {
                        setBillingAction(null);
                    }
                },
            });

            razorpay.on("payment.failed", async (response) => {
                completed = true;
                setBillingNotice({
                    tone: "error",
                    message: response.error?.description || response.error?.reason || "Razorpay payment failed. No subscription was activated.",
                });
                setBillingAction(null);
                await loadBilling();
            });

            razorpay.open();
        } catch (err) {
            setBillingNotice({
                tone: "error",
                message: err instanceof Error ? err.message : "Unable to start Razorpay Checkout.",
            });
            setBillingAction(null);
        }
    };

    const validateForm = () => {
        const errors: Partial<Record<"name" | "businessType" | "legalName" | "contactEmail" | "contactPhone" | "address" | "paymentGraceDays", string>> = {};
        if (!form) return { errors, values: null };
        const nameResult = validateRequiredText(form.name, "Organization name", 120);
        const businessTypeResult = validateOptionalText(form.businessType, "Business type", 80);
        const legalNameResult = validateOptionalText(form.legalName, "Legal name", 160);
        const contactEmailResult = validateOptionalEmail(form.contactEmail, "Contact email");
        const contactPhoneResult = validateRequiredPhone(form.contactPhone, "Contact phone");
        const addressResult = validateOptionalText(form.address, "Address", 240);
        const paymentGraceDaysResult = parseIntegerField(form.paymentGraceDays, "Payment grace days", {
            min: 0,
            max: 60,
        });

        if (!nameResult.ok) errors.name = nameResult.error;
        if (!businessTypeResult.ok) errors.businessType = businessTypeResult.error;
        if (!legalNameResult.ok) errors.legalName = legalNameResult.error;
        if (!contactEmailResult.ok) errors.contactEmail = contactEmailResult.error;
        if (!contactPhoneResult.ok) errors.contactPhone = contactPhoneResult.error;
        if (!addressResult.ok) errors.address = addressResult.error;
        if (!paymentGraceDaysResult.ok) errors.paymentGraceDays = paymentGraceDaysResult.error;

        if (
            !nameResult.ok ||
            !businessTypeResult.ok ||
            !legalNameResult.ok ||
            !contactEmailResult.ok ||
            !contactPhoneResult.ok ||
            !addressResult.ok ||
            !paymentGraceDaysResult.ok
        ) return { errors, values: null };
        return {
            errors,
            values: {
                nameResult,
                businessTypeResult,
                legalNameResult,
                contactEmailResult,
                contactPhoneResult,
                addressResult,
                paymentGraceDaysResult,
            },
        };
    };

    const validation = validateForm();
    const nameError = visibleError("name", validation.errors);
    const businessTypeError = visibleError("businessType", validation.errors);
    const legalNameError = visibleError("legalName", validation.errors);
    const contactEmailError = visibleError("contactEmail", validation.errors);
    const contactPhoneError = visibleError("contactPhone", validation.errors);
    const addressError = visibleError("address", validation.errors);
    const paymentGraceDaysError = visibleError("paymentGraceDays", validation.errors);

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
            businessTypeResult,
            legalNameResult,
            contactEmailResult,
            contactPhoneResult,
            addressResult,
            paymentGraceDaysResult,
        } = result.values;
        setSaving(true);
        setSaveStatus("idle");
        setSaveError("");
        try {
            const res = await fetch(`/api/organizations/${orgId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...form,
                    name: nameResult.value,
                    businessType: businessTypeResult.value ?? null,
                    legalName: legalNameResult.value ?? null,
                    contactEmail: contactEmailResult.value ?? null,
                    contactPhone: contactPhoneResult.value,
                    address: addressResult.value ?? null,
                    paymentGraceDays: paymentGraceDaysResult.value ?? 0,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || "Failed to save organization settings");
            }
            const updated = await res.json();
            const nextOrg = { ...(org as OrgDetails), ...updated };
            setOrg(nextOrg);
            setForm(toForm(nextOrg));
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
        return <PageLoadingSkeleton label="Loading organization settings" variant="settings" maxWidth="content" />;
    }

    if (fetchError || !org || !form) {
        return (
            <div className={pageErrorStateClass}>
                <AlertCircle className={pageErrorIconClass} />
                <p className={pageMutedTextClass}>{fetchError || "Organization not found."}</p>
                <AppButton variant="secondary" onClick={() => router.back()}>Back</AppButton>
            </div>
        );
    }

    return (
        <>
            <SettingsWorkspace
                title="Organization Settings"
                subtitle="Configure business identity, contact details, and workspace defaults."
                sections={SECTIONS}
                activeSection={activeSection}
                onSectionChange={setActiveSection}
            >
                <SettingsPanel id="profile" title="Business Profile" description="Core business information used across this organization." icon={Building2}>
                    <SettingsField label="Organization name" description="The public workspace name." error={nameError} errorId="org-name-error">
                        <SettingsInput value={form.name} onChange={e => updateForm("name", e.target.value)} onBlur={() => markTouched("name")} placeholder="Organization name" error={nameError} errorId="org-name-error" />
                    </SettingsField>
                    <SettingsField label="Legal name" description="Optional legal or billing name." error={legalNameError} errorId="org-legal-name-error">
                        <SettingsInput value={form.legalName ?? ""} onChange={e => updateForm("legalName", e.target.value)} onBlur={() => markTouched("legalName")} placeholder="Registered business name" error={legalNameError} errorId="org-legal-name-error" />
                    </SettingsField>
                    <SettingsField label="Business type" error={businessTypeError} errorId="org-business-type-error">
                        <SettingsSelect value={form.businessType ?? ""} onChange={e => updateForm("businessType", e.target.value)} onBlur={() => markTouched("businessType")} error={businessTypeError} errorId="org-business-type-error">
                            <option value="">Not set</option>
                            {BUSINESS_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                        </SettingsSelect>
                    </SettingsField>
                </SettingsPanel>

                <SettingsPanel id="contact" title="Contact" description="Contact details for operations and billing conversations." icon={MapPin}>
                    <SettingsField label="Contact email" error={contactEmailError} errorId="org-contact-email-error">
                        <SettingsInput value={form.contactEmail ?? ""} onChange={e => updateForm("contactEmail", e.target.value)} onBlur={() => markTouched("contactEmail")} placeholder="owner@example.com" error={contactEmailError} errorId="org-contact-email-error" />
                    </SettingsField>
                    <SettingsField label="Contact phone" description="Required phone number for owner and operations contact." error={contactPhoneError} errorId="org-contact-phone-error">
                        <SettingsInput value={form.contactPhone ?? ""} onChange={e => updateForm("contactPhone", e.target.value)} onBlur={() => markTouched("contactPhone")} placeholder="+91 98765 43210" error={contactPhoneError} errorId="org-contact-phone-error" />
                    </SettingsField>
                    <SettingsField label="Address" error={addressError} errorId="org-address-error">
                        <SettingsTextArea value={form.address ?? ""} onChange={e => updateForm("address", e.target.value)} onBlur={() => markTouched("address")} placeholder="Organization address" error={addressError} errorId="org-address-error" />
                    </SettingsField>
                </SettingsPanel>

                <SettingsPanel id="regional" title="Regional Defaults" description="Defaults new branches can align with later." icon={Clock}>
                    <SettingsField label="Timezone">
                        <SettingsSelect value={form.timezone} onChange={e => updateForm("timezone", e.target.value)}>
                            <option value="Asia/Kolkata">Asia/Kolkata</option>
                            <option value="UTC">UTC</option>
                        </SettingsSelect>
                    </SettingsField>
                    <SettingsField label="Currency">
                        <SettingsSelect value={form.currency} onChange={e => updateForm("currency", e.target.value)}>
                            <option value="INR">INR</option>
                            <option value="USD">USD</option>
                        </SettingsSelect>
                    </SettingsField>
                    <SettingsField label="Week starts on">
                        <SegmentedControl
                            value={String(form.weekStartsOn) as "0" | "1"}
                            onChange={value => updateForm("weekStartsOn", Number(value) as 0 | 1)}
                            options={[
                                { value: "1", label: "Monday" },
                                { value: "0", label: "Sunday" },
                            ]}
                        />
                    </SettingsField>
                    <SettingsField label="Payment grace days" description="Stored organization policy for payment follow-up windows." error={paymentGraceDaysError} errorId="org-payment-grace-days-error">
                        <SettingsInput type="number" min={0} max={60} value={form.paymentGraceDays} onChange={e => updateForm("paymentGraceDays", Number(e.target.value))} onBlur={() => markTouched("paymentGraceDays")} error={paymentGraceDaysError} errorId="org-payment-grace-days-error" />
                    </SettingsField>
                </SettingsPanel>

                <SettingsPanel id="branches" title="Branches" description="Open a branch to manage branch-level settings." icon={GitBranch}>
                    <ReadOnlyRow label="Total branches" value={org._count.branches} />
                    <div className="grid gap-2 px-5 py-4 md:grid-cols-2">
                        {org.branches.length === 0 ? (
                            <SettingsEmptyState>No branches yet.</SettingsEmptyState>
                        ) : org.branches.map(branch => (
                            <SettingsCard
                                key={branch.id}
                                onClick={() => router.push(`/branch/${branch.id}/settings`)}
                            >
                                <div className="flex items-center gap-2 text-sm font-medium text-[color:var(--text-primary)]">
                                    <GitBranch size={14} className="text-[color:var(--ui-form-accent)]" />
                                    {branch.name}
                                </div>
                                <SettingsSubtleText className="mt-1">
                                    {branch.city || "No city set"} / {format(new Date(branch.createdAt), "PP")}
                                </SettingsSubtleText>
                            </SettingsCard>
                        ))}
                    </div>
                </SettingsPanel>

                <SettingsPanel id="billing" title="Billing" description="Workspace subscription and Razorpay billing state." icon={CreditCard}>
                    {billingNotice && (
                        <div className={cn(
                            "mx-5 my-4 flex items-center gap-2 px-4 py-2 text-sm",
                            billingNotice.tone === "success"
                                ? formSuccessBannerClass
                                : billingNotice.tone === "warning"
                                    ? formWarningBannerClass
                                    : "rounded-[var(--ui-radius-panel)] border border-red-500/25 bg-red-500/10 text-red-200"
                        )}>
                            {billingNotice.tone === "error" ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
                            <span>{billingNotice.message}</span>
                        </div>
                    )}

                    <div className="px-5 py-4">
                        {billingLoading ? (
                            <div className="flex min-h-28 items-center justify-center text-sm text-[color:var(--text-primary)]">
                                <Loader2 className="mr-2 animate-spin" size={18} />
                                Loading billing plans...
                            </div>
                        ) : (
                            <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
                                {(billingOverview?.plans ?? []).map(plan => (
                                    <BillingPlanCard
                                        key={plan.id}
                                        plan={plan}
                                        current={billingOverview?.current ?? null}
                                        busyPlan={billingAction}
                                        onStart={startSubscription}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    {billingOverview?.current && (
                        <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
                            <ReadOnlyBillingMetric label="Current plan" value={billingOverview.current.shortName} />
                            <ReadOnlyBillingMetric label="Status" value={billingOverview.current.status} />
                            <ReadOnlyBillingMetric
                                label="Next charge"
                                value={billingOverview.current.chargeAt ? format(new Date(billingOverview.current.chargeAt), "PP") : "Not scheduled"}
                            />
                        </div>
                    )}
                </SettingsPanel>

                <SettingsPanel id="system" title="System Info" description="Owner and identifiers are read-only." icon={Shield}>
                    <ReadOnlyRow label="Owner" value={<span className="inline-flex items-center gap-2"><Mail size={14} />{org.owner?.email || org.ownerId}</span>} />
                    <ReadOnlyRow label="Organization ID" value={<span className="font-mono">{org.id}</span>} />
                    <ReadOnlyRow label="Created" value={<span className="inline-flex items-center gap-2"><Calendar size={14} />{format(new Date(org.createdAt), "PPP")}</span>} />
                    <ReadOnlyRow label="Business type" value={<span className="inline-flex items-center gap-2"><Briefcase size={14} />{org.businessType || "Not set"}</span>} />
                    <ReadOnlyRow label="Billing currency" value={<span className="inline-flex items-center gap-2"><CreditCard size={14} />{org.currency}</span>} />
                    <ReadOnlyRow label="Contact phone" value={<span className="inline-flex items-center gap-2"><Phone size={14} />{org.contactPhone || "Not set"}</span>} />
                    <ReadOnlyRow label="Owner ID" value={<span className="font-mono">{org.ownerId}</span>} />
                    <ReadOnlyRow label="Hash" value={<span className="inline-flex items-center gap-2"><Hash size={14} />System managed</span>} />
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

const TERMINAL_BILLING_STATUSES = new Set(["CANCELLED", "COMPLETED", "EXPIRED"]);

function formatPlanAmount(plan: BillingPlanDto) {
    if (plan.amount == null || plan.custom) return "Custom";
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: plan.currency,
        maximumFractionDigits: 0,
    }).format(plan.amount);
}

function isCurrentBillingPlan(plan: BillingPlanDto, current: OrganizationSubscriptionDto | null) {
    return current?.plan === plan.id && !TERMINAL_BILLING_STATUSES.has(current.status);
}

function BillingPlanCard({
    plan,
    current,
    busyPlan,
    onStart,
}: {
    plan: BillingPlanDto;
    current: OrganizationSubscriptionDto | null;
    busyPlan: BillingPlanId | null;
    onStart: (plan: BillingPlanId) => void;
}) {
    const isCurrent = isCurrentBillingPlan(plan, current);
    const isBusy = busyPlan === plan.id;
    const disabled = Boolean(busyPlan) || isCurrent || !plan.active;
    const buttonLabel = plan.comingSoon
        ? "Coming soon"
        : plan.custom
            ? "Custom"
            : isCurrent
                ? "Current plan"
                : `Start ${plan.shortName}`;

    return (
        <div className={cn(
            "flex min-h-[340px] flex-col rounded-[var(--ui-radius-panel)] border p-4",
            plan.featured
                ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]"
                : "border-[color:var(--ui-panel-border)] bg-[color:var(--ui-form-surface-bg)]"
        )}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{plan.shortName}</h3>
                    <SettingsSubtleText className="mt-1">{plan.description}</SettingsSubtleText>
                </div>
                {plan.featured && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-2 py-1 text-[10px] font-semibold uppercase text-[color:var(--ui-badge-cyan-text)]">
                        <Sparkles size={11} />
                        Popular
                    </span>
                )}
            </div>

            <div className="mt-5">
                <span className="text-2xl font-semibold text-[color:var(--text-primary)]">{formatPlanAmount(plan)}</span>
                {!plan.custom && <span className="ml-1 text-xs text-[color:var(--text-secondary)]">/ month</span>}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
                {isCurrent && current && (
                    <span className="rounded-full border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] px-2 py-1 text-[10px] font-semibold uppercase text-[color:var(--ui-badge-success-text)]">
                        {current.status}
                    </span>
                )}
                {!plan.active && (
                    <span className="rounded-full border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-2 py-1 text-[10px] font-semibold uppercase text-[color:var(--text-secondary)]">
                        {plan.custom ? "Custom" : "Soon"}
                    </span>
                )}
            </div>

            <div className="mt-5 flex-1 space-y-2.5">
                {plan.features.map(feature => (
                    <div key={feature} className="flex gap-2 text-sm text-[color:var(--text-secondary)]">
                        {plan.active ? (
                            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[color:var(--ui-badge-success-text)]" />
                        ) : (
                            <XCircle size={15} className="mt-0.5 shrink-0 text-[color:var(--text-secondary)]" />
                        )}
                        <span>{feature}</span>
                    </div>
                ))}
            </div>

            <AppButton
                variant={plan.featured ? "primary" : "secondary"}
                size="sm"
                className="mt-5 w-full"
                disabled={disabled}
                isLoading={isBusy}
                onClick={() => onStart(plan.id)}
            >
                {buttonLabel}
            </AppButton>
        </div>
    );
}

function ReadOnlyBillingMetric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] px-4 py-3">
            <div className="text-xs text-[color:var(--text-secondary)]">{label}</div>
            <div className="mt-1 truncate text-sm font-semibold text-[color:var(--text-primary)]">{value}</div>
        </div>
    );
}
