"use client";

import { Suspense, use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Script from "next/script";
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
    Loader2,
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
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
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
import {
    isCheckoutBillingPlanId,
    type CheckoutBillingPlanId,
} from "@/lib/billingPlans";
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
    prefill?: BillingCheckoutPayload["prefill"];
    notes?: BillingCheckoutPayload["notes"];
    subscription_card_change?: boolean;
    theme: { color: string };
    retry: { enabled: boolean };
    method?: BillingCheckoutPayload["method"];
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
    return (
        <Suspense fallback={<PageLoadingSkeleton label="Loading organization settings" variant="settings" maxWidth="content" />}>
            <OrgSettingsContent params={params} />
        </Suspense>
    );
}

function OrgSettingsContent({ params }: { params: Promise<{ orgId: string }> }) {
    const { orgId } = use(params);
    const router = useRouter();
    const searchParams = useSearchParams();
    const billingPlanParam = searchParams.get("billingPlan");
    const requestedBillingPlanId = isCheckoutBillingPlanId(billingPlanParam) ? billingPlanParam : null;
    const returnToParam = searchParams.get("returnTo");
    const requestedReturnPath = returnToParam?.startsWith("/") && !returnToParam.startsWith("//") && !returnToParam.includes("\\")
        ? returnToParam
        : null;

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
    const [billingAction, setBillingAction] = useState<CheckoutBillingPlanId | null>(null);
    const [recoveryLoading, setRecoveryLoading] = useState(false);
    const [autoStartedPlan, setAutoStartedPlan] = useState<CheckoutBillingPlanId | null>(null);
    const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
    const [cancellingSubscription, setCancellingSubscription] = useState(false);
    const [checkoutScriptReady, setCheckoutScriptReady] = useState(
        () => typeof window !== "undefined" && Boolean(window.Razorpay)
    );
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

    const startSubscription = useCallback(async (planId: CheckoutBillingPlanId) => {
        if (billingOverview?.current
            && !TERMINAL_BILLING_STATUSES.has(billingOverview.current.status)
            && billingOverview.current.status !== "CREATED") {
            setBillingAction(planId);
            setBillingNotice(null);
            try {
                const result = await billing.changePlan(
                    orgId,
                    planId,
                    requestedReturnPath ?? window.location.pathname + window.location.search + window.location.hash
                ) as { processingUrl?: string };
                setBillingNotice({ tone: "warning", message: "Your plan change is being reconciled with Razorpay." });
                if (result.processingUrl) router.push(result.processingUrl);
                else await loadBilling();
            } catch (err) {
                setBillingNotice({ tone: "error", message: err instanceof Error ? err.message : "Unable to change plan." });
            } finally {
                setBillingAction(null);
            }
            return;
        }
        if (!checkoutScriptReady || !window.Razorpay) {
            setBillingNotice({
                tone: "warning",
                message: "Razorpay Checkout is still loading. Please try again in a moment.",
            });
            return;
        }

        setBillingAction(planId);
        setBillingNotice(null);

        try {
            const checkout = await billing.createSubscription(orgId, planId, requestedReturnPath ?? window.location.pathname + window.location.search + window.location.hash);
            setBillingOverview(prev => prev ? { ...prev, current: checkout.subscription } : prev);

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
                method: checkout.method,
                modal: {
                    confirm_close: true,
                    ondismiss: async () => {
                        if (completed) return;
                        await billing.recordCheckoutEvent(orgId, checkout.changeId, "ABANDONED").catch(() => undefined);
                        setBillingNotice({
                            tone: "warning",
                            message: "Checkout closed before payment. You can restart checkout for this plan when you are ready.",
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
                            changeId: checkout.changeId,
                        });
                        setBillingOverview(prev => prev ? { ...prev, current: result.subscription } : prev);
                        setBillingNotice({
                            tone: result.subscription.status === "ACTIVE" ? "success" : "warning",
                            message: result.subscription.status === "ACTIVE"
                                ? "Subscription is active."
                                : "Subscription authorization is verified. Razorpay may finish activation shortly.",
                        });
                        router.push(result.processingUrl);
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
                await billing.recordCheckoutEvent(orgId, checkout.changeId, "DECLINED", {
                    failureCategory: response.error?.reason,
                    failureCode: response.error?.code,
                }).catch(() => undefined);
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
    }, [billingOverview, checkoutScriptReady, loadBilling, orgId, requestedReturnPath, router]);

    const startRecovery = useCallback(async () => {
        if (!checkoutScriptReady || !window.Razorpay) {
            setBillingNotice({ tone: "warning", message: "Razorpay Checkout is still loading. Please try again in a moment." });
            return;
        }
        setRecoveryLoading(true);
        setBillingNotice(null);
        try {
            const recovery = await billing.createRecovery(orgId, window.location.pathname + window.location.search + window.location.hash);
            let completed = false;
            const razorpay = new window.Razorpay({
                key: recovery.keyId,
                name: "Lab Lords",
                description: "Update card and retry subscription payment",
                subscription_id: recovery.subscriptionId,
                subscription_card_change: true,
                theme: { color: "#22c55e" },
                retry: { enabled: true },
                method: recovery.method,
                modal: {
                    confirm_close: true,
                    ondismiss: async () => {
                        if (completed) return;
                        await billing.recordCheckoutEvent(orgId, recovery.changeId, "ABANDONED").catch(() => undefined);
                        setBillingNotice({ tone: "warning", message: "Card recovery was closed. The workspace remains in its current access state." });
                        setRecoveryLoading(false);
                    },
                },
                handler: async response => {
                    completed = true;
                    try {
                        const result = await billing.verifySubscription(orgId, {
                            changeId: recovery.changeId,
                            razorpay_subscription_id: response.razorpay_subscription_id ?? recovery.subscriptionId,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature,
                        });
                        router.push(result.processingUrl);
                    } catch (requestError) {
                        setBillingNotice({ tone: "error", message: requestError instanceof Error ? requestError.message : "Unable to verify card recovery." });
                    } finally {
                        setRecoveryLoading(false);
                    }
                },
            });
            razorpay.on("payment.failed", async response => {
                completed = true;
                await billing.recordCheckoutEvent(orgId, recovery.changeId, "DECLINED", {
                    failureCategory: response.error?.reason,
                    failureCode: response.error?.code,
                }).catch(() => undefined);
                setBillingNotice({ tone: "error", message: response.error?.description || "Card recovery was not confirmed." });
                setRecoveryLoading(false);
            });
            razorpay.open();
        } catch (requestError) {
            setBillingNotice({ tone: "error", message: requestError instanceof Error ? requestError.message : "Unable to start card recovery." });
            setRecoveryLoading(false);
        }
    }, [checkoutScriptReady, orgId, router]);

    const confirmCancellation = useCallback(async () => {
        if (!cancelDialogOpen) return;
        setCancellingSubscription(true);
        setBillingNotice(null);
        try {
            const result = await billing.cancelSubscription(orgId);
            setBillingOverview(prev => prev ? { ...prev, current: result.subscription } : prev);
            setBillingNotice({
                tone: result.scheduled ? "warning" : "success",
                message: result.scheduled
                    ? "Cancellation is scheduled for the end of the current billing cycle."
                    : "The subscription has been cancelled.",
            });
            setCancelDialogOpen(false);
            await loadBilling();
        } catch (err) {
            setBillingNotice({
                tone: "error",
                message: err instanceof Error ? err.message : "Unable to cancel the subscription.",
            });
        } finally {
            setCancellingSubscription(false);
        }
    }, [cancelDialogOpen, loadBilling, orgId]);

    useEffect(() => {
        if (!requestedBillingPlanId) return;
        setActiveSection("billing");

        const selectedPlan = billingOverview?.plans.find(plan => plan.id === requestedBillingPlanId);
        if (!selectedPlan || billingLoading) return;

        if (isCurrentBillingPlan(selectedPlan, billingOverview?.current ?? null)) {
            if (autoStartedPlan !== requestedBillingPlanId) {
                setAutoStartedPlan(requestedBillingPlanId);
                setBillingNotice({
                    tone: "success",
                    message: `${selectedPlan.shortName} is already your current plan.`,
                });
            }
            return;
        }

        if (!selectedPlan.active) {
            if (autoStartedPlan !== requestedBillingPlanId) {
                setAutoStartedPlan(requestedBillingPlanId);
                setBillingNotice({
                    tone: "warning",
                    message: `${selectedPlan.shortName} is not available for checkout yet.`,
                });
            }
            return;
        }

        if (!checkoutScriptReady || billingAction || autoStartedPlan === requestedBillingPlanId) return;
        setAutoStartedPlan(requestedBillingPlanId);
        void startSubscription(requestedBillingPlanId);
    }, [
        autoStartedPlan,
        billingAction,
        billingLoading,
        billingOverview,
        checkoutScriptReady,
        requestedBillingPlanId,
        startSubscription,
    ]);

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
            <Script
                id="razorpay-checkout"
                src="https://checkout.razorpay.com/v1/checkout.js"
                strategy="afterInteractive"
                onReady={() => setCheckoutScriptReady(true)}
                onError={() => {
                    setCheckoutScriptReady(false);
                    setBillingNotice({
                        tone: "error",
                        message: "Razorpay Checkout could not be loaded. Check your connection and refresh the page.",
                    });
                }}
            />
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
                            <div className="grid gap-3 lg:grid-cols-2">
                                {(billingOverview?.plans ?? []).map(plan => (
                                    <BillingPlanCard
                                        key={plan.id}
                                        plan={plan}
                                        current={billingOverview?.current ?? null}
                                        busyPlan={billingAction}
                                        checkoutReady={checkoutScriptReady}
                                        onStart={startSubscription}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    {billingOverview?.experience && (
                        <div className="mx-5 rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-4 py-3 text-sm">
                            <p className="font-semibold text-[color:var(--text-primary)]">{formatBillingCustomerState(billingOverview.experience.customerState)}</p>
                            <p className="mt-1 text-[color:var(--text-secondary)]">{billingOverview.experience.customerMessage}</p>
                            {(billingOverview.experience.paymentAction === "UPDATE_CARD" || billingOverview.experience.paymentAction === "RETRY_PAYMENT") && (
                                <AppButton className="mt-3" size="sm" onClick={startRecovery} isLoading={recoveryLoading}>Update card and retry payment</AppButton>
                            )}
                        </div>
                    )}

                    {billingOverview?.current && (
                        <div className="space-y-3 px-5 py-4">
                            <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
                                <ReadOnlyBillingMetric label="Current plan" value={billingOverview.current.shortName} />
                                <ReadOnlyBillingMetric label="Billing state" value={formatBillingCustomerState(billingOverview.experience.customerState)} />
                                <ReadOnlyBillingMetric label="Payment method" value={billingOverview.paymentMethod ?? "Not authorized"} />
                                <ReadOnlyBillingMetric
                                    label="Paid through"
                                    value={billingOverview.current.paidThrough ? format(new Date(billingOverview.current.paidThrough), "PP") : "Awaiting paid invoice"}
                                />
                                <ReadOnlyBillingMetric
                                    label="Next charge"
                                    value={billingOverview.experience.nextChargeAt ? format(new Date(billingOverview.experience.nextChargeAt), "PP") : "Not scheduled"}
                                />
                            </div>

                            {billingOverview.current.cancelAtCycleEnd ? (
                                <div className={cn(formWarningBannerClass, "px-4 py-3 text-sm")}>
                                    Cancellation is scheduled
                                    {billingOverview.current.cancellationScheduledAt
                                        ? ` for ${format(new Date(billingOverview.current.cancellationScheduledAt), "PP")}`
                                        : " for the end of the current billing cycle"}.
                                </div>
                            ) : billingOverview.current.status === "ACTIVE" ? (
                                <div className="flex flex-wrap justify-end gap-2">
                                    <AppButton
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => setCancelDialogOpen(true)}
                                    >
                                        Cancel at cycle end
                                    </AppButton>
                                </div>
                            ) : null}
                        </div>
                    )}

                    {billingOverview?.trial && (
                        <div className="mx-5 mt-4 rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-4 py-3 text-sm text-[color:var(--text-primary)]">
                            {billingOverview.trial.claimable ? (
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <span>Your owner account has one available 30-day Standard trial.</span>
                                    <AppButton size="sm" onClick={async () => { await billing.claimTrial(orgId); await loadBilling(); }}>
                                        Start trial here
                                    </AppButton>
                                </div>
                            ) : (
                                <span>
                                    Standard trial: {billingOverview.trial.status.toLowerCase()}
                                    {billingOverview.trial.endsAt ? ` until ${format(new Date(billingOverview.trial.endsAt), "PP")}` : ""}.
                                </span>
                            )}
                        </div>
                    )}

                    {billingOverview && (
                        <div className="grid gap-3 px-5 pt-4 sm:grid-cols-2 lg:grid-cols-4">
                            <ReadOnlyBillingMetric label="Price per branch" value={`₹${billingOverview.experience.projectedUnitAmount}/month`} />
                            <ReadOnlyBillingMetric label="Billable branches" value={String(billingOverview.experience.projectedQuantity)} />
                            <ReadOnlyBillingMetric label="Projected total" value={`₹${billingOverview.experience.projectedMonthlyTotal}/month`} />
                            <ReadOnlyBillingMetric label="Access" value={billingOverview.experience.accessMode === "READ_ONLY" ? "Read-only" : billingOverview.experience.accessMode === "WARNING" ? "Full access · payment attention needed" : "Full access"} />
                        </div>
                    )}

                    {(billingOverview?.experience.scheduledChanges.length ?? 0) > 0 && (
                        <div className="border-t border-[color:var(--ui-form-section-divider)] px-5 py-4">
                            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Scheduled changes</h3>
                            <div className="mt-3 space-y-2">
                                {billingOverview?.experience.scheduledChanges.map(change => (
                                    <div key={change.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] px-3 py-2 text-xs">
                                        <span className="text-[color:var(--text-primary)]">
                                            {formatBillingChangeType(change.type)} · {change.status === "SCHEDULED" ? "Scheduled" : "Awaiting confirmation"}
                                            {change.effectiveAt ? ` · ${format(new Date(change.effectiveAt), "PP")}` : ""}
                                        </span>
                                        {(change.status === "SCHEDULED" || change.status === "FAILED" || change.status === "AWAITING_PROVIDER_CONFIRMATION") && (
                                            <AppButton variant="secondary" size="sm" onClick={async () => { await billing.undoChange(orgId, change.id); await loadBilling(); }}>
                                                Undo
                                            </AppButton>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {(billingOverview?.invoices.length ?? 0) > 0 && (
                        <div className="border-t border-[color:var(--ui-form-section-divider)] px-5 py-4">
                            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Invoices</h3>
                            <div className="mt-3 space-y-2">
                                {billingOverview?.invoices.map(invoice => (
                                    <div key={invoice.id} className="flex justify-between rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] px-3 py-2 text-xs">
                                        <span>{invoice.status.toUpperCase()}</span>
                                        <span>₹{invoice.amountSubunits / 100}{invoice.paidAt ? ` · ${format(new Date(invoice.paidAt), "PP")}` : ""}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {(billingOverview?.history.length ?? 0) > 0 && (
                        <div className="border-t border-[color:var(--ui-form-section-divider)] px-5 py-4">
                            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Subscription history</h3>
                            <div className="mt-3 space-y-2">
                                {billingOverview?.history.slice(0, 8).map(entry => (
                                    <div
                                        key={entry.id}
                                        className="flex flex-col gap-1 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
                                    >
                                        <span className="font-medium text-[color:var(--text-primary)]">
                                            {entry.plan} · {entry.fromStatus ? `${entry.fromStatus} → ` : ""}{entry.toStatus}
                                        </span>
                                        <span className="text-[color:var(--text-secondary)]">
                                            {entry.source.replaceAll("_", " ")} · {format(new Date(entry.createdAt), "PPp")}
                                        </span>
                                    </div>
                                ))}
                            </div>
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
            <ConfirmDialog
                isOpen={cancelDialogOpen}
                onClose={() => setCancelDialogOpen(false)}
                onConfirm={confirmCancellation}
                loading={cancellingSubscription}
                variant="danger"
                title="Cancel at cycle end?"
                description="Your current access remains available until this billing cycle ends. Razorpay will not renew the subscription afterward. Already-paid fees are handled under the Cancellation and Refund Policy."
                confirmText="Schedule cancellation"
            />
        </>
    );
}

const TERMINAL_BILLING_STATUSES = new Set(["CANCELLED", "COMPLETED", "EXPIRED"]);

function formatBillingCustomerState(state: BillingOverview["experience"]["customerState"]) {
    const labels: Record<BillingOverview["experience"]["customerState"], string> = {
        TRIAL_ACTIVE: "Standard trial active",
        BASIC_ACTIVE: "Basic active",
        STANDARD_ACTIVE: "Standard active",
        PAYMENT_RETRYING: "Payment retry in progress",
        PAYMENT_HALTED: "Payment method needs attention",
        CONFIRMING: "Confirming with Razorpay",
        PAYMENT_NOT_COMPLETED: "Payment not completed",
        PAYMENT_DECLINED: "Card authorization declined",
        PAYMENT_FAILED: "Billing update failed",
        ACCESS_ENDED: "Paid access ended",
        AUTHORIZATION_REQUIRED: "Card authorization required",
    };
    return labels[state];
}

function formatBillingChangeType(type: string) {
    const labels: Record<string, string> = {
        SUBSCRIPTION_AUTHORIZATION: "Subscription authorization",
        TRIAL_SUBSCRIPTION_UPDATE: "Post-trial subscription update",
        PLAN_UPGRADE: "Upgrade to Standard",
        PLAN_DOWNGRADE: "Downgrade to Basic",
        QUANTITY_INCREASE: "Branch quantity increase",
        BRANCH_REMOVAL: "Branch removal",
        BRANCH_REACTIVATION: "Branch reactivation",
        CANCELLATION: "Subscription cancellation",
    };
    return labels[type] ?? "Billing change";
}

function formatPlanAmount(plan: BillingPlanDto) {
    if (plan.amount == null || plan.custom) return "Custom";
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: plan.currency,
        maximumFractionDigits: 0,
    }).format(plan.amount);
}

function isCurrentBillingPlan(plan: BillingPlanDto, current: OrganizationSubscriptionDto | null) {
    return current?.plan === plan.id
        && current.status !== "CREATED"
        && !TERMINAL_BILLING_STATUSES.has(current.status);
}

function BillingPlanCard({
    plan,
    current,
    busyPlan,
    checkoutReady,
    onStart,
}: {
    plan: BillingPlanDto;
    current: OrganizationSubscriptionDto | null;
    busyPlan: CheckoutBillingPlanId | null;
    checkoutReady: boolean;
    onStart: (plan: CheckoutBillingPlanId) => void;
}) {
    const isCurrent = isCurrentBillingPlan(plan, current);
    const isBusy = busyPlan === plan.id;
    const disabled = !checkoutReady || Boolean(busyPlan) || isCurrent || !plan.active;
    const buttonLabel = plan.comingSoon
        ? "Coming soon"
        : plan.custom
            ? "Custom"
            : isCurrent
                ? "Current plan"
                : !checkoutReady
                    ? "Loading checkout..."
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
                {!plan.custom && <span className="ml-1 text-xs text-[color:var(--text-secondary)]">/ branch / month</span>}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
                {isCurrent && current && (
                    <span className="rounded-full border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] px-2 py-1 text-[10px] font-semibold uppercase text-[color:var(--ui-badge-success-text)]">
                        Current plan
                    </span>
                )}
                {!plan.active && (
                    <span className="rounded-full border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-2 py-1 text-[10px] font-semibold uppercase text-[color:var(--text-secondary)]">
                        {plan.custom ? "Custom" : "Soon"}
                    </span>
                )}
            </div>

            <div className="mt-5 flex-1 space-y-2.5">
                {plan.capabilities.map(capability => (
                    <div key={capability.id} className={cn("flex gap-2 text-sm", capability.included ? "text-[color:var(--text-secondary)]" : "text-[color:var(--text-muted)]")}>
                        {capability.included ? (
                            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[color:var(--ui-badge-success-text)]" />
                        ) : (
                            <XCircle size={15} className="mt-0.5 shrink-0 text-[color:var(--text-secondary)]" />
                        )}
                        <span>{capability.label}{capability.included ? "" : " — Standard only"}</span>
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
