"use client";

import { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
    MessageCircle,
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
import { OrganizationWhatsAppPanel } from "@/components/whatsapp/OrganizationWhatsAppPanel";
import { BillingPriceSummary } from "@/components/billing/BillingPriceSummary";
import { BillingPaymentMethodsOverview } from "@/components/billing/BillingPaymentMethodsOverview";
import { CheckoutConfirmationDialog } from "@/components/billing/CheckoutConfirmationDialog";
import { PaymentOutcomeDialog, type PaymentOutcome } from "@/components/billing/PaymentOutcomeDialog";
import {
    isRazorpayCheckoutPayload,
    isRazorpayCheckoutReady,
    openRazorpayCheckout,
    RazorpayCheckoutScript,
    type RazorpayCheckoutEventResult,
    type RazorpayCheckoutMode,
    type RazorpayCheckoutPayloadLike,
} from "@/components/billing/RazorpayCheckoutLauncher";
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
import { billing, type BillingOverview, type BillingPlanDto, type OrganizationSubscriptionDto } from "@/lib/api/billing";
import {
    isCheckoutBillingPlanId,
    type CheckoutBillingPlanId,
} from "@/lib/billingPlans";
import { cn } from "@/lib/utils";
import {
    getProviderPaymentMethodLabel,
    isSupportedRecurringPaymentMethod,
} from "@/lib/billingPaymentMethods";

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

const SECTIONS_WITH_WHATSAPP = [
    ...SECTIONS.slice(0, 4),
    { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
    ...SECTIONS.slice(4),
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
    const [whatsAppAvailable, setWhatsAppAvailable] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
    const [saveError, setSaveError] = useState("");
    const [billingOverview, setBillingOverview] = useState<BillingOverview | null>(null);
    const [billingLoading, setBillingLoading] = useState(true);
    const [billingAction, setBillingAction] = useState<CheckoutBillingPlanId | null>(null);
    const [billingOperationLoading, setBillingOperationLoading] = useState(false);
    const billingOperationInFlightRef = useRef(false);
    const [recoveryLoading, setRecoveryLoading] = useState(false);
    const [recoveryConfirmationOpen, setRecoveryConfirmationOpen] = useState(false);
    const [confirmationPlan, setConfirmationPlan] = useState<CheckoutBillingPlanId | null>(null);
    const [handledQueryPlan, setHandledQueryPlan] = useState<CheckoutBillingPlanId | null>(null);
    const [paymentOutcome, setPaymentOutcome] = useState<PaymentOutcome | null>(null);
    const [paymentOutcomeMode, setPaymentOutcomeMode] = useState<RazorpayCheckoutMode>("AUTHORIZATION");
    const [outcomeChangeId, setOutcomeChangeId] = useState<string | null>(null);
    const [outcomePlanId, setOutcomePlanId] = useState<CheckoutBillingPlanId | null>(null);
    const [retryingOutcome, setRetryingOutcome] = useState(false);
    const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
    const [cancellingSubscription, setCancellingSubscription] = useState(false);
    const [checkoutScriptReady, setCheckoutScriptReady] = useState(
        () => isRazorpayCheckoutReady()
    );
    const [billingNotice, setBillingNotice] = useState<{ tone: "success" | "warning" | "error"; message: string } | null>(null);
    const { markTouched, markSubmitted, resetFieldErrors, visibleError } = useInlineFieldErrors<
        "name" | "businessType" | "legalName" | "contactEmail" | "contactPhone" | "address" | "paymentGraceDays"
    >();

    const setBillingOperationBusy = useCallback((busy: boolean) => {
        billingOperationInFlightRef.current = busy;
        setBillingOperationLoading(busy);
    }, []);

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

    const organizationCanEdit = billingOverview?.entitlements.canWrite ?? false;
    const organizationEditReason = billingOverview?.entitlements.accessReason
        ?? (billingLoading ? "Checking workspace access..." : "Organization settings are unavailable until billing access is restored.");

    const updateForm = <K extends keyof OrgForm>(key: K, value: OrgForm[K]) => {
        if (!organizationCanEdit || !isEditing) return;
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

    const discardChanges = () => {
        reset();
        setIsEditing(false);
        setDiscardDialogOpen(false);
    };

    const requestCancelEditing = () => {
        if (hasChanges) {
            setDiscardDialogOpen(true);
            return;
        }
        discardChanges();
    };

    const beginEditing = () => {
        if (!organizationCanEdit) return;
        setSaveStatus("idle");
        setSaveError("");
        setIsEditing(true);
    };

    const launchCheckout = useCallback((
        payload: RazorpayCheckoutPayloadLike,
        mode: RazorpayCheckoutMode,
        planId: CheckoutBillingPlanId | null = null
    ) => {
        openRazorpayCheckout({
            payload,
            mode,
            verify: async response => {
                const result = await billing.verifySubscription(orgId, {
                    changeId: payload.changeId,
                    razorpay_subscription_id: response.razorpay_subscription_id ?? payload.subscriptionId,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature,
                });
                setBillingOverview(previous => previous
                    ? result.subscription.position === "PENDING_REPLACEMENT"
                        ? { ...previous, pendingReplacement: result.subscription }
                        : { ...previous, current: result.subscription }
                    : previous);
                return result;
            },
            recordEvent: async (checkoutResult: RazorpayCheckoutEventResult) => {
                await billing.recordCheckoutEvent(
                    orgId,
                    payload.changeId,
                    checkoutResult.event,
                    checkoutResult.failure
                );
            },
            navigate: processingUrl => router.push(processingUrl),
            onStateChange: state => {
                if (state === "OPEN") {
                    setBillingOperationBusy(true);
                    if (planId) setBillingAction(planId);
                    return;
                }
                if (state === "VERIFYING") {
                    setBillingOperationBusy(true);
                    setBillingNotice({ tone: "warning", message: "Razorpay authorization received. Verifying it securely..." });
                    return;
                }
                if (state === "AWAITING_PROVIDER_CONFIRMATION") {
                    setBillingOperationBusy(true);
                    setBillingNotice({ tone: "warning", message: "Confirmation is taking longer than usual. We are checking Razorpay before changing access." });
                    return;
                }
                if (state === "ABANDONED" || state === "DECLINED" || state === "FAILED") {
                    setOutcomeChangeId(payload.changeId);
                    setOutcomePlanId(planId);
                    setPaymentOutcomeMode(mode);
                    setPaymentOutcome({ status: state });
                    setBillingAction(null);
                    setBillingOperationBusy(false);
                    setRecoveryLoading(false);
                    void loadBilling();
                }
            },
            onVerificationError: () => {
                setBillingNotice({ tone: "warning", message: "Browser verification was interrupted. Provider reconciliation is continuing safely." });
            },
        });
    }, [loadBilling, orgId, router, setBillingOperationBusy]);

    const requestSubscription = useCallback((planId: CheckoutBillingPlanId) => {
        setBillingNotice(null);
        setPaymentOutcome(null);
        setConfirmationPlan(planId);
    }, []);

    const confirmSubscription = useCallback(async () => {
        const planId = confirmationPlan;
        if (!planId) return;
        const current = billingOverview?.current;
        const providerUpdate = canChangeProviderPlan(current ?? null);
        const replacementUpdate = requiresReplacementPlanChange(current ?? null);

        if (current && RECOVERY_BILLING_STATUSES.has(current.status)) {
            setConfirmationPlan(null);
            setBillingNotice({
                tone: "warning",
                message: "Restore the subscription payment before changing the plan.",
            });
            return;
        }
        if (current?.cancelAtCycleEnd) {
            setConfirmationPlan(null);
            setBillingNotice({
                tone: "warning",
                message: "Undo the scheduled cancellation before changing the plan.",
            });
            return;
        }
        if (current && !TERMINAL_BILLING_STATUSES.has(current.status) && current.status !== "CREATED" && !providerUpdate) {
            setConfirmationPlan(null);
            setBillingNotice({
                tone: "warning",
                message: "This subscription needs a confirmed supported recurring payment method before its plan can be changed.",
            });
            return;
        }
        if (billingOperationInFlightRef.current) return;

        setBillingOperationBusy(true);
        setBillingAction(planId);
        setBillingNotice(null);
        try {
            if (providerUpdate) {
                if (replacementUpdate && !checkoutScriptReady && !isRazorpayCheckoutReady()) {
                    setBillingNotice({ tone: "warning", message: "Razorpay Checkout is still loading. Please try again in a moment." });
                    setBillingAction(null);
                    setBillingOperationBusy(false);
                    return;
                }
                setConfirmationPlan(null);
                const result = await billing.changePlan(
                    orgId,
                    planId,
                    requestedReturnPath ?? window.location.pathname + window.location.hash
                );
                if ("purpose" in result && isRazorpayCheckoutPayload(result)) {
                    setBillingOverview(previous => previous
                        ? { ...previous, pendingReplacement: result.subscription }
                        : previous);
                    launchCheckout(result, "AUTHORIZATION", planId);
                    return;
                }
                setBillingNotice({ tone: "warning", message: "Your plan change is being reconciled with Razorpay." });
                if (result.processingUrl) router.push(result.processingUrl);
                else {
                    await loadBilling();
                    setBillingAction(null);
                    setBillingOperationBusy(false);
                }
                return;
            }

            if (!checkoutScriptReady || !isRazorpayCheckoutReady()) {
                setBillingNotice({ tone: "warning", message: "Razorpay Checkout is still loading. Please try again in a moment." });
                setBillingAction(null);
                setBillingOperationBusy(false);
                return;
            }

            const checkout = await billing.createSubscription(
                orgId,
                planId,
                requestedReturnPath ?? window.location.pathname + window.location.hash
            );
            setBillingOverview(previous => previous ? { ...previous, current: checkout.subscription } : previous);
            launchCheckout(checkout, "AUTHORIZATION", planId);
            setConfirmationPlan(null);
        } catch (error) {
            setBillingNotice({ tone: "error", message: error instanceof Error ? error.message : "Unable to start Razorpay authorization." });
            setBillingAction(null);
            setBillingOperationBusy(false);
        }
    }, [billingOverview, checkoutScriptReady, confirmationPlan, launchCheckout, loadBilling, orgId, requestedReturnPath, router, setBillingOperationBusy]);

    const startRecovery = useCallback(async () => {
        if (billingOperationInFlightRef.current) return;
        setRecoveryLoading(true);
        setBillingOperationBusy(true);
        setBillingNotice(null);
        try {
            const recovery = await billing.createRecovery(orgId, window.location.pathname + window.location.hash);
            setRecoveryConfirmationOpen(false);
            if ("hostedRecoveryUrl" in recovery && recovery.hostedRecoveryUrl) {
                window.location.assign(recovery.hostedRecoveryUrl);
                return;
            }
            if (!checkoutScriptReady || !isRazorpayCheckoutReady()) {
                router.push(recovery.processingUrl);
                return;
            }
            if (recovery.purpose === "REPLACEMENT") {
                setBillingOverview(previous => previous
                    ? { ...previous, pendingReplacement: recovery.subscription }
                    : previous);
            }
            launchCheckout(
                recovery,
                recovery.purpose === "REPLACEMENT" ? "AUTHORIZATION" : "RECOVERY"
            );
        } catch (error) {
            setBillingNotice({ tone: "error", message: error instanceof Error ? error.message : "Unable to start payment recovery." });
            setRecoveryLoading(false);
            setBillingOperationBusy(false);
        }
    }, [checkoutScriptReady, launchCheckout, orgId, router, setBillingOperationBusy]);

    const startPaymentMethodChange = useCallback(async () => {
        const current = billingOverview?.current;
        if (
            billingOperationInFlightRef.current
            || billingOverview?.pendingReplacement
            || !current
            || !isCheckoutBillingPlanId(current.plan)
            || !isSupportedRecurringPaymentMethod(current.providerPaymentMethod)
        ) return;
        if (!checkoutScriptReady || !isRazorpayCheckoutReady()) {
            setBillingNotice({ tone: "warning", message: "Razorpay Checkout is still loading. Please try again in a moment." });
            return;
        }
        setBillingOperationBusy(true);
        setBillingNotice(null);
        try {
            const checkout = await billing.changePaymentMethod(
                orgId,
                window.location.pathname + window.location.hash
            );
            if (!("purpose" in checkout) || !isRazorpayCheckoutPayload(checkout)) {
                if (checkout.processingUrl) router.push(checkout.processingUrl);
                else await loadBilling();
                setBillingOperationBusy(false);
                return;
            }
            setBillingOverview(previous => previous
                ? { ...previous, pendingReplacement: checkout.subscription }
                : previous);
            launchCheckout(checkout, "AUTHORIZATION", current.plan);
        } catch (error) {
            setBillingNotice({
                tone: "error",
                message: error instanceof Error ? error.message : "Unable to start payment-method authorization.",
            });
            setBillingOperationBusy(false);
        }
    }, [billingOverview, checkoutScriptReady, launchCheckout, loadBilling, orgId, router, setBillingOperationBusy]);

    const retryBillingOperation = useCallback(async (changeId: string, planId: CheckoutBillingPlanId | null = null) => {
        const result = await billing.retryOperation(orgId, changeId) as unknown;
        if (isRazorpayCheckoutPayload(result)) {
            if (!checkoutScriptReady || !isRazorpayCheckoutReady()) {
                setBillingNotice({ tone: "warning", message: "Razorpay Checkout is still loading. Please try again in a moment." });
                return "REFRESHED" as const;
            }
            launchCheckout(result, result.subscription_card_change ? "RECOVERY" : "AUTHORIZATION", planId);
            return "CHECKOUT" as const;
        }
        const processingResult = result as { processingUrl?: string };
        if (processingResult.processingUrl) {
            router.push(processingResult.processingUrl);
            return "PROCESSING" as const;
        }
        await loadBilling();
        return "REFRESHED" as const;
    }, [checkoutScriptReady, launchCheckout, loadBilling, orgId, router]);

    const retryPaymentOutcome = useCallback(async () => {
        if (billingOperationInFlightRef.current) return;
        if (!checkoutScriptReady || !isRazorpayCheckoutReady()) {
            setBillingNotice({ tone: "warning", message: "Razorpay Checkout is still loading. Please try again in a moment." });
            return;
        }
        if (!outcomeChangeId) {
            setPaymentOutcome(null);
            if (outcomePlanId) setConfirmationPlan(outcomePlanId);
            return;
        }
        setBillingOperationBusy(true);
        setRetryingOutcome(true);
        setBillingNotice(null);
        try {
            const result = await retryBillingOperation(outcomeChangeId, outcomePlanId);
            setPaymentOutcome(null);
            if (result === "REFRESHED") setBillingOperationBusy(false);
        } catch (error) {
            setBillingNotice({ tone: "error", message: error instanceof Error ? error.message : "Unable to retry authorization." });
            setBillingOperationBusy(false);
        } finally {
            setRetryingOutcome(false);
        }
    }, [checkoutScriptReady, outcomeChangeId, outcomePlanId, retryBillingOperation, setBillingOperationBusy]);

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

    const undoBillingChange = useCallback(async (changeId: string) => {
        if (billingOperationInFlightRef.current) return;
        setBillingOperationBusy(true);
        setBillingNotice(null);
        try {
            await billing.undoChange(orgId, changeId);
            await loadBilling();
            setBillingNotice({ tone: "success", message: "The pending billing change was undone." });
        } catch (error) {
            setBillingNotice({
                tone: "error",
                message: error instanceof Error ? error.message : "Unable to undo the billing change.",
            });
        } finally {
            setBillingOperationBusy(false);
        }
    }, [loadBilling, orgId, setBillingOperationBusy]);

    useEffect(() => {
        if (!requestedBillingPlanId) return;
        setActiveSection("billing");

        if (!billingOverview || billingLoading || handledQueryPlan === requestedBillingPlanId) return;
        const selectedPlan = billingOverview.plans.find(plan => plan.id === requestedBillingPlanId);
        if (!selectedPlan) return;
        setHandledQueryPlan(requestedBillingPlanId);
        const current = billingOverview.current;
        const experience = billingOverview.experience;

        if (experience.activeOperation) {
            setBillingNotice({
                tone: "warning",
                message: "A billing confirmation is already in progress. Finish or reconcile it before starting another change.",
            });
            return;
        }
        if (current && RECOVERY_BILLING_STATUSES.has(current.status)) {
            setBillingNotice({
                tone: "warning",
                message: "Restore the current recurring payment before changing plans.",
            });
            return;
        }
        if (current?.cancelAtCycleEnd) {
            setBillingNotice({
                tone: "warning",
                message: "Undo the scheduled cancellation before changing plans.",
            });
            return;
        }

        if (isAuthorizedPostTrialPlan(selectedPlan, current, experience)) {
            setBillingNotice({
                tone: "success",
                message: `${selectedPlan.shortName} is already authorized for after the trial.`,
            });
            return;
        }

        if (isCurrentBillingPlan(selectedPlan, current, experience)) {
            setBillingNotice({
                tone: "success",
                message: `${selectedPlan.shortName} is already your current paid plan.`,
            });
            return;
        }

        if (!selectedPlan.active) {
            setBillingNotice({
                tone: "warning",
                message: `${selectedPlan.shortName} is not available for checkout yet.`,
            });
            return;
        }

        setConfirmationPlan(requestedBillingPlanId);
    }, [
        billingLoading,
        billingOverview,
        handledQueryPlan,
        requestedBillingPlanId,
    ]);

    const handleBillingAction = useCallback(async () => {
        const experience = billingOverview?.experience;
        if (!experience || billingOperationInFlightRef.current) return;
        const operationId = experience.activeOperation?.id ?? experience.latestOperation?.id;
        setBillingOperationBusy(true);
        try {
            if (experience.paymentAction === "UPDATE_CARD") {
                if (experience.providerStatus === "PAUSED") {
                    setBillingOperationBusy(false);
                    await startPaymentMethodChange();
                    return;
                }
                setRecoveryConfirmationOpen(true);
                setBillingOperationBusy(false);
                return;
            }
            if (experience.paymentAction === "WAIT_FOR_CONFIRMATION" && operationId) {
                router.push(`/org/${encodeURIComponent(orgId)}/billing/processing/${encodeURIComponent(operationId)}`);
                return;
            }
            if ((experience.paymentAction === "CONTINUE_CHECKOUT"
                || experience.paymentAction === "RETRY_AUTHORIZATION"
                || experience.paymentAction === "RETRY_BILLING_CHANGE") && operationId) {
                const checkoutRequired = experience.paymentAction !== "RETRY_BILLING_CHANGE";
                if (checkoutRequired && (!checkoutScriptReady || !isRazorpayCheckoutReady())) {
                    setBillingNotice({ tone: "warning", message: "Razorpay Checkout is still loading. Please try again in a moment." });
                    setBillingOperationBusy(false);
                    return;
                }
                const result = await retryBillingOperation(
                    operationId,
                    experience.selectedPostTrialPlan === "STANDARD" ? "PRO" : experience.selectedPostTrialPlan
                );
                if (result === "REFRESHED") setBillingOperationBusy(false);
                return;
            }
            if (experience.selectedPostTrialPlan) {
                requestSubscription(experience.selectedPostTrialPlan === "STANDARD" ? "PRO" : "BASIC");
                setBillingOperationBusy(false);
                return;
            }
            setActiveSection("billing");
            setBillingOperationBusy(false);
        } catch (error) {
            setBillingNotice({
                tone: "error",
                message: error instanceof Error ? error.message : "Unable to continue the billing operation.",
            });
            setBillingOperationBusy(false);
        }
    }, [billingOverview, checkoutScriptReady, orgId, requestSubscription, retryBillingOperation, router, setBillingOperationBusy, startPaymentMethodChange]);

    const confirmationPlanDetails = confirmationPlan
        ? billingOverview?.plans.find(plan => plan.id === confirmationPlan) ?? null
        : null;
    const confirmationUsesProviderUpdate = Boolean(
        canChangeProviderPlan(billingOverview?.current ?? null)
    );
    const confirmationUsesReplacement = requiresReplacementPlanChange(billingOverview?.current ?? null);
    const confirmationChangeTiming = confirmationUsesReplacement
        ? "AUTHORIZATION" as const
        : !confirmationUsesProviderUpdate
        ? "AUTHORIZATION" as const
        : billingOverview?.experience.effectivePlan === "STANDARD_TRIAL"
            ? "FUTURE_TRIAL" as const
            : billingOverview?.experience.effectivePlan === "STANDARD" && confirmationPlan === "BASIC"
                ? "NEXT_CYCLE" as const
                : "IMMEDIATE_PRORATION" as const;

    const checkoutMethodAvailability: BillingOverview["checkoutMethodAvailability"] = billingOverview?.checkoutMethodAvailability
        ?? (billingOverview?.multiMethodSubscriptionsEnabled
            ? {
                mode: "PROVIDER_MANAGED",
                potentialMethods: ["CARD", "UPI", "EMANDATE"],
                providerControlsVisibility: true,
            }
            : undefined);
    const pendingReplacement = billingOverview?.pendingReplacement ?? null;
    const pendingReplacementChange = billingOverview?.scheduledChanges
        .slice()
        .reverse()
        .find(change => PENDING_REPLACEMENT_CHANGE_TYPES.has(change.type)) ?? null;
    const pendingReplacementEffectiveAt = pendingReplacementChange?.effectiveAt
        ?? pendingReplacement?.providerStartAt
        ?? pendingReplacement?.chargeAt
        ?? null;
    const pendingReplacementAuthorized = Boolean(
        pendingReplacement && PROVIDER_PLAN_UPDATE_STATUSES.has(pendingReplacement.status)
    );
    const complimentaryReplacementAccess = Boolean(
        pendingReplacementAuthorized
        && billingOverview?.current
        && (
            planRank(pendingReplacement!.plan) > planRank(billingOverview.current.plan)
            || pendingReplacement!.quantity > billingOverview.current.quantity
        )
    );
    const pendingReplacementCanUndo = Boolean(
        pendingReplacementChange
        && UNDOABLE_REPLACEMENT_STATUSES.has(pendingReplacementChange.status)
        && (
            !pendingReplacementChange.undoCutoffAt
            || new Date(pendingReplacementChange.undoCutoffAt).getTime() > Date.now()
        )
    );

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
        if (!form || !isEditing) return;
        if (!organizationCanEdit) {
            setSaveError(organizationEditReason);
            setSaveStatus("error");
            return;
        }
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
            setIsEditing(false);
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
            <RazorpayCheckoutScript
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
                sections={whatsAppAvailable ? SECTIONS_WITH_WHATSAPP : SECTIONS}
                activeSection={activeSection}
                onSectionChange={setActiveSection}
                actions={!isEditing ? (
                    <AppButton
                        variant="primary"
                        size="sm"
                        disabled={!organizationCanEdit}
                        title={!organizationCanEdit ? organizationEditReason : undefined}
                        onClick={beginEditing}
                        className="min-h-11 lg:min-h-9"
                    >
                        Edit settings
                    </AppButton>
                ) : null}
            >
                {billingOverview && !organizationCanEdit ? (
                    <aside className={cn("flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between", formWarningBannerClass)}>
                        <p>{organizationEditReason}</p>
                        <a href="#billing" className="shrink-0 font-semibold underline underline-offset-4">Review billing</a>
                    </aside>
                ) : null}
                <SettingsPanel id="profile" title="Business Profile" description="Core business information used across this organization." icon={Building2}>
                    {isEditing && organizationCanEdit ? (
                        <>
                            <SettingsField label="Organization name" description="The public workspace name." error={nameError} errorId="org-name-error">
                                <SettingsInput value={form.name} onChange={e => updateForm("name", e.target.value)} onBlur={() => markTouched("name")} placeholder="Organization name" error={nameError} errorId="org-name-error" />
                            </SettingsField>
                            <SettingsField label="Legal name" description="Optional legal or billing name." error={legalNameError} errorId="org-legal-name-error">
                                <SettingsInput value={form.legalName ?? ""} onChange={e => updateForm("legalName", e.target.value)} onBlur={() => markTouched("legalName")} placeholder="Registered business name" error={legalNameError} errorId="org-legal-name-error" />
                            </SettingsField>
                            <SettingsField label="Business type" error={businessTypeError} errorId="org-business-type-error">
                                <SettingsSelect
                                    value={form.businessType ?? ""}
                                    onValueChange={value => updateForm("businessType", value)}
                                    onBlur={() => markTouched("businessType")}
                                    error={businessTypeError}
                                    errorId="org-business-type-error"
                                    options={[
                                        { value: "", label: "Not set" },
                                        ...BUSINESS_TYPES.map(type => ({ value: type, label: type })),
                                    ]}
                                />
                            </SettingsField>
                        </>
                    ) : (
                        <>
                            <ReadOnlyRow label="Organization name" value={org.name} />
                            <ReadOnlyRow label="Legal name" value={org.legalName || "Not set"} />
                            <ReadOnlyRow label="Business type" value={org.businessType || "Not set"} />
                        </>
                    )}
                </SettingsPanel>

                <SettingsPanel id="contact" title="Contact" description="Contact details for operations and billing conversations." icon={MapPin}>
                    {isEditing && organizationCanEdit ? (
                        <>
                            <SettingsField label="Contact email" error={contactEmailError} errorId="org-contact-email-error">
                                <SettingsInput value={form.contactEmail ?? ""} onChange={e => updateForm("contactEmail", e.target.value)} onBlur={() => markTouched("contactEmail")} placeholder="owner@example.com" error={contactEmailError} errorId="org-contact-email-error" />
                            </SettingsField>
                            <SettingsField label="Contact phone" description="Required phone number for owner and operations contact." error={contactPhoneError} errorId="org-contact-phone-error">
                                <SettingsInput value={form.contactPhone ?? ""} onChange={e => updateForm("contactPhone", e.target.value)} onBlur={() => markTouched("contactPhone")} placeholder="+91 98765 43210" error={contactPhoneError} errorId="org-contact-phone-error" />
                            </SettingsField>
                            <SettingsField label="Address" error={addressError} errorId="org-address-error">
                                <SettingsTextArea value={form.address ?? ""} onChange={e => updateForm("address", e.target.value)} onBlur={() => markTouched("address")} placeholder="Organization address" error={addressError} errorId="org-address-error" />
                            </SettingsField>
                        </>
                    ) : (
                        <>
                            <ReadOnlyRow label="Contact email" value={org.contactEmail || "Not set"} />
                            <ReadOnlyRow label="Contact phone" value={org.contactPhone || "Not set"} />
                            <ReadOnlyRow label="Address" value={org.address || "Not set"} />
                        </>
                    )}
                </SettingsPanel>

                <SettingsPanel id="regional" title="Regional Defaults" description="Defaults new branches can align with later." icon={Clock}>
                    {isEditing && organizationCanEdit ? (
                        <>
                            <SettingsField label="Timezone">
                                <SettingsSelect
                                    value={form.timezone}
                                    onValueChange={value => updateForm("timezone", value)}
                                    options={[
                                        { value: "Asia/Kolkata", label: "Asia/Kolkata" },
                                        { value: "UTC", label: "UTC" },
                                    ]}
                                />
                            </SettingsField>
                            <SettingsField label="Currency">
                                <SettingsSelect
                                    value={form.currency}
                                    onValueChange={value => updateForm("currency", value)}
                                    options={[
                                        { value: "INR", label: "INR" },
                                        { value: "USD", label: "USD" },
                                    ]}
                                />
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
                        </>
                    ) : (
                        <>
                            <ReadOnlyRow label="Timezone" value={org.timezone} />
                            <ReadOnlyRow label="Currency" value={org.currency} />
                            <ReadOnlyRow label="Week starts on" value={org.weekStartsOn === 0 ? "Sunday" : "Monday"} />
                            <ReadOnlyRow label="Payment grace days" value={org.paymentGraceDays} />
                        </>
                    )}
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

                <OrganizationWhatsAppPanel
                    organizationId={orgId}
                    organizationName={org.name}
                    onAvailabilityChange={setWhatsAppAvailable}
                />

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

                    {billingOverview?.experience && (
                        <div className="mx-5 mt-4 rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-4 py-3 text-sm">
                            <p className="font-semibold text-[color:var(--text-primary)]">{formatBillingCustomerState(billingOverview.experience.customerState)}</p>
                            <p className="mt-1 text-[color:var(--text-secondary)]">{billingOverview.experience.customerMessage}</p>
                            {billingOverview.experience.paymentAction !== "NONE"
                                && billingOverview.experience.paymentAction !== "CHOOSE_PLAN"
                                && billingOverview.experience.paymentAction !== "AUTHORIZE_CARD" ? (
                                <AppButton
                                    className="mt-3"
                                    size="sm"
                                    onClick={() => void handleBillingAction()}
                                    isLoading={recoveryLoading || billingOperationLoading}
                                    disabled={recoveryLoading || billingOperationLoading}
                                >
                                    {formatBillingAction(billingOverview.experience.paymentAction)}
                                </AppButton>
                            ) : null}
                        </div>
                    )}

                    {billingOverview ? (
                        <BillingPriceSummary experience={billingOverview.experience} current={billingOverview.current} />
                    ) : null}

                    {pendingReplacement ? (
                        <section
                            className="mx-5 mt-4 rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-4 py-3 text-sm"
                            aria-label="Pending subscription replacement"
                        >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                    <p className="font-semibold text-[color:var(--text-primary)]">
                                        {pendingReplacement.shortName} replacement mandate
                                    </p>
                                    <p className="mt-1 text-[color:var(--text-secondary)]">
                                        {getProviderPaymentMethodLabel(pendingReplacement.providerPaymentMethod)}
                                        {pendingReplacementEffectiveAt
                                            ? ` · planned for ${format(new Date(pendingReplacementEffectiveAt), "PP")}`
                                            : " · cutover date will appear after Razorpay confirms the mandate"}
                                    </p>
                                    <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                                        Current billing, invoices, and paid-through dates remain on the existing subscription until cutover.
                                    </p>
                                    {complimentaryReplacementAccess ? (
                                        <p className="mt-2 font-medium text-[color:var(--ui-badge-success-text)]">
                                            Complimentary upgrade access is active while billing remains on the current subscription.
                                        </p>
                                    ) : null}
                                </div>
                                {pendingReplacementCanUndo && pendingReplacementChange ? (
                                    <AppButton
                                        variant="secondary"
                                        size="sm"
                                        disabled={billingOperationLoading}
                                        isLoading={billingOperationLoading}
                                        onClick={() => void undoBillingChange(pendingReplacementChange.id)}
                                    >
                                        Undo
                                    </AppButton>
                                ) : null}
                            </div>
                        </section>
                    ) : null}

                    {billingOverview ? (
                        <BillingPaymentMethodsOverview
                            availability={checkoutMethodAvailability}
                            currentMethod={billingOverview.current?.providerPaymentMethod}
                            canChangeMethod={Boolean(
                                billingOverview.current
                                && isSupportedRecurringPaymentMethod(billingOverview.current.providerPaymentMethod)
                                && isCheckoutBillingPlanId(billingOverview.current.plan)
                                && checkoutMethodAvailability?.mode === "PROVIDER_MANAGED"
                                && !pendingReplacement
                            )}
                            changeDisabled={Boolean(billingOverview.experience.activeOperation)}
                            changeLoading={billingOperationLoading}
                            onChangeMethod={() => void startPaymentMethodChange()}
                        />
                    ) : null}

                    <section className="px-5 py-5" aria-labelledby="billing-plans-title">
                        <div className="mb-4">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">Plans</p>
                            <h3 id="billing-plans-title" className="mt-1 text-base font-semibold text-[color:var(--text-primary)]">
                                Choose the right workspace plan
                            </h3>
                            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
                                Monthly billing is based on the selected plan and active branch count. You review the total before continuing to Razorpay.
                            </p>
                        </div>
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
                                        experience={billingOverview?.experience ?? null}
                                        busyPlan={billingAction}
                                        checkoutReady={checkoutScriptReady}
                                        onStart={requestSubscription}
                                    />
                                ))}
                            </div>
                        )}
                    </section>

                    {billingOverview?.current
                        && (billingOverview.current.cancelAtCycleEnd || billingOverview.current.status === "ACTIVE") ? (
                        <section className="space-y-3 px-5 py-4" aria-labelledby="subscription-controls-title">
                            <div>
                                <h3 id="subscription-controls-title" className="text-sm font-semibold text-[color:var(--text-primary)]">Subscription controls</h3>
                                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                                    Cancellation preserves access through the end of the current paid billing cycle.
                                </p>
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
                        </section>
                    ) : null}

                    {billingOverview?.ownerTrialEligibility?.claimable && !billingOverview.trial && (
                        <div className="mx-5 mt-4 rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-4 py-3 text-sm text-[color:var(--text-primary)]">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <span>Your owner account has one available 30-day Standard trial.</span>
                                <AppButton size="sm" onClick={async () => { await billing.claimTrial(orgId); await loadBilling(); }}>
                                    Start trial here
                                </AppButton>
                            </div>
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
                                            <AppButton variant="secondary" size="sm" onClick={() => void undoBillingChange(change.id)}>
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
                visible={isEditing}
                hasChanges={hasChanges}
                saving={saving}
                status={saveStatus}
                error={saveError}
                onSave={save}
                onCancel={requestCancelEditing}
            />
            <ConfirmDialog
                isOpen={discardDialogOpen}
                onClose={() => setDiscardDialogOpen(false)}
                onConfirm={discardChanges}
                variant="warning"
                title="Discard organization changes?"
                description="Your unsaved organization settings will be restored to their last saved values."
                confirmText="Discard changes"
                cancelText="Keep editing"
            />
            {confirmationPlanDetails && billingOverview ? (
                <CheckoutConfirmationDialog
                    isOpen={confirmationPlan != null}
                    loading={billingAction === confirmationPlanDetails.id}
                    purpose={confirmationUsesReplacement ? "REPLACEMENT" : "PLAN"}
                    planName={confirmationPlanDetails.id === "PRO" ? "Standard" : "Basic"}
                    unitAmount={confirmationPlanDetails.amount ?? 0}
                    quantity={billingOverview.experience.projectedQuantity}
                    monthlyTotal={(confirmationPlanDetails.amount ?? 0) * billingOverview.experience.projectedQuantity}
                    trialActive={billingOverview.experience.effectivePlan === "STANDARD_TRIAL"}
                    changeTiming={confirmationChangeTiming}
                    trialEndsAt={billingOverview.experience.trialEndsAt}
                    providerChargeAt={billingOverview.experience.nextChargeAt}
                    effectiveAt={confirmationChangeTiming === "NEXT_CYCLE"
                        ? billingOverview.current?.currentEnd ?? billingOverview.experience.paidThrough
                        : null}
                    planFeeDueToday={confirmationUsesReplacement || billingOverview.experience.effectivePlan === "STANDARD_TRIAL"
                        ? 0
                        : (confirmationPlanDetails.amount ?? 0) * billingOverview.experience.projectedQuantity}
                    contactEmail={org.contactEmail || org.owner?.email}
                    contactPhone={org.contactPhone}
                    testMode={billingOverview.razorpayTestMode}
                    multiMethodEnabled={checkoutMethodAvailability?.mode === "PROVIDER_MANAGED"}
                    onClose={() => setConfirmationPlan(null)}
                    onConfirm={confirmSubscription}
                />
            ) : null}
            <PaymentOutcomeDialog
                outcome={paymentOutcome}
                mode={paymentOutcomeMode}
                retrying={retryingOutcome}
                onRetry={retryPaymentOutcome}
                onClose={() => setPaymentOutcome(null)}
            />
            {billingOverview?.current ? (
                <CheckoutConfirmationDialog
                    isOpen={recoveryConfirmationOpen}
                    loading={recoveryLoading}
                    purpose="RECOVERY"
                    planName={billingOverview.current.plan === "PRO" ? "Standard" : "Basic"}
                    unitAmount={billingOverview.current.unitAmount}
                    quantity={billingOverview.current.quantity}
                    monthlyTotal={billingOverview.current.monthlyTotal}
                    trialActive={false}
                    changeTiming="AUTHORIZATION"
                    trialEndsAt={null}
                    providerChargeAt={billingOverview.experience.nextChargeAt}
                    effectiveAt={null}
                    planFeeDueToday={billingOverview.current.monthlyTotal}
                    contactEmail={org.contactEmail || org.owner?.email}
                    contactPhone={org.contactPhone}
                    testMode={billingOverview.razorpayTestMode}
                    multiMethodEnabled={checkoutMethodAvailability?.mode === "PROVIDER_MANAGED"}
                    onClose={() => setRecoveryConfirmationOpen(false)}
                    onConfirm={startRecovery}
                />
            ) : null}
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
const PROVIDER_PLAN_UPDATE_STATUSES = new Set(["AUTHENTICATED", "ACTIVE"]);
const RECOVERY_BILLING_STATUSES = new Set(["PENDING", "HALTED"]);
const PENDING_REPLACEMENT_CHANGE_TYPES = new Set([
    "PAYMENT_METHOD_REPLACEMENT",
    "PLAN_UPGRADE",
    "PLAN_DOWNGRADE",
    "TRIAL_SUBSCRIPTION_UPDATE",
    "QUANTITY_INCREASE",
    "BRANCH_REACTIVATION",
    "BRANCH_REMOVAL",
]);
const UNDOABLE_REPLACEMENT_STATUSES = new Set([
    "QUEUED",
    "PROCESSING",
    "AWAITING_PAYMENT",
    "SCHEDULED",
    "FAILED",
]);

function canChangeProviderPlan(subscription: OrganizationSubscriptionDto | null) {
    return Boolean(
        subscription
        && PROVIDER_PLAN_UPDATE_STATUSES.has(subscription.status)
        && isSupportedRecurringPaymentMethod(subscription.providerPaymentMethod)
        && !subscription.cancelAtCycleEnd
    );
}

function requiresReplacementPlanChange(subscription: OrganizationSubscriptionDto | null) {
    return Boolean(
        canChangeProviderPlan(subscription)
        && subscription?.providerPaymentMethod !== "CARD"
    );
}

function planRank(plan: OrganizationSubscriptionDto["plan"]) {
    if (plan === "PRO") return 2;
    if (plan === "BASIC") return 1;
    return 0;
}

function formatBillingCustomerState(state: BillingOverview["experience"]["customerState"]) {
    const labels: Record<BillingOverview["experience"]["customerState"], string> = {
        TRIAL_ACTIVE: "Standard trial active",
        BASIC_ACTIVE: "Basic active",
        STANDARD_ACTIVE: "Standard active",
        PAYMENT_RETRYING: "Payment retry in progress",
        PAYMENT_HALTED: "Payment method needs attention",
        CONFIRMING: "Confirming with Razorpay",
        PAYMENT_NOT_COMPLETED: "Payment not completed",
        PAYMENT_DECLINED: "Payment authorization declined",
        PAYMENT_FAILED: "Billing update failed",
        ACCESS_ENDED: "Paid access ended",
        AUTHORIZATION_REQUIRED: "Payment-method authorization required",
    };
    return labels[state];
}
function formatBillingAction(action: BillingOverview["experience"]["paymentAction"]) {
    const labels: Record<BillingOverview["experience"]["paymentAction"], string> = {
        NONE: "Manage billing",
        CHOOSE_PLAN: "Choose plan",
        CONTINUE_CHECKOUT: "Continue authorization",
        WAIT_FOR_CONFIRMATION: "View confirmation",
        RETRY_AUTHORIZATION: "Retry authorization",
        RETRY_BILLING_CHANGE: "Retry billing change",
        UPDATE_CARD: "Update payment method and retry",
        AUTHORIZE_CARD: "Authorize payment method",
    };
    return labels[action];
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
        PAYMENT_METHOD_REPLACEMENT: "Payment method replacement",
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

function isCurrentBillingPlan(
    plan: BillingPlanDto,
    current: OrganizationSubscriptionDto | null,
    experience: BillingOverview["experience"] | null | undefined
) {
    const effectivePlanId = experience?.effectivePlan === "STANDARD"
        ? "PRO"
        : experience?.effectivePlan === "BASIC"
            ? "BASIC"
            : null;
    return current?.plan === plan.id
        && current.paidThrough != null
        && effectivePlanId === plan.id;
}

function isAuthorizedPostTrialPlan(
    plan: BillingPlanDto,
    current: OrganizationSubscriptionDto | null,
    experience: BillingOverview["experience"] | null | undefined
) {
    const selectedPlanId = experience?.selectedPostTrialPlan === "STANDARD"
        ? "PRO"
        : experience?.selectedPostTrialPlan === "BASIC"
            ? "BASIC"
            : null;
    return experience?.effectivePlan === "STANDARD_TRIAL"
        && experience.authorizationStatus === "AUTHORIZED"
        && selectedPlanId === plan.id
        && current?.plan === plan.id;
}

function BillingPlanCard({
    plan,
    current,
    experience,
    busyPlan,
    checkoutReady,
    onStart,
}: {
    plan: BillingPlanDto;
    current: OrganizationSubscriptionDto | null;
    experience: BillingOverview["experience"] | null;
    busyPlan: CheckoutBillingPlanId | null;
    checkoutReady: boolean;
    onStart: (plan: CheckoutBillingPlanId) => void;
}) {
    const isCurrent = isCurrentBillingPlan(plan, current, experience);
    const selectedPlanId = experience?.selectedPostTrialPlan === "STANDARD"
        ? "PRO"
        : experience?.selectedPostTrialPlan === "BASIC"
            ? "BASIC"
            : null;
    const isSelectedAfterTrial = experience?.effectivePlan === "STANDARD_TRIAL" && selectedPlanId === plan.id;
    const isAuthorizedAfterTrial = isAuthorizedPostTrialPlan(plan, current, experience);
    const providerUpdate = canChangeProviderPlan(current);
    const replacementUpdate = requiresReplacementPlanChange(current);
    const recoveryRequired = Boolean(current && RECOVERY_BILLING_STATUSES.has(current.status));
    const cancellationScheduled = Boolean(current?.cancelAtCycleEnd);
    const unsupportedProviderUpdate = Boolean(
        current
        && !TERMINAL_BILLING_STATUSES.has(current.status)
        && current.status !== "CREATED"
        && !providerUpdate
        && !recoveryRequired
        && !cancellationScheduled
    );
    const isBusy = busyPlan === plan.id;
    const operationInProgress = Boolean(experience?.activeOperation);
    const requiresCheckout = !providerUpdate || replacementUpdate;
    const disabled = (!checkoutReady && requiresCheckout)
        || Boolean(busyPlan)
        || operationInProgress
        || isCurrent
        || isAuthorizedAfterTrial
        || recoveryRequired
        || cancellationScheduled
        || unsupportedProviderUpdate
        || !plan.active;
    let buttonLabel = `Authorize ${plan.shortName}`;
    if (plan.comingSoon) buttonLabel = "Coming soon";
    else if (plan.custom) buttonLabel = "Custom";
    else if (isCurrent) buttonLabel = "Current plan";
    else if (isAuthorizedAfterTrial) buttonLabel = "Authorized for after trial";
    else if (recoveryRequired) buttonLabel = "Resolve payment first";
    else if (cancellationScheduled) buttonLabel = "Undo cancellation first";
    else if (unsupportedProviderUpdate) buttonLabel = "Payment method confirmation required";
    else if (operationInProgress) buttonLabel = "Authorization in progress";
    else if (providerUpdate && experience?.effectivePlan === "STANDARD_TRIAL") {
        buttonLabel = `Change to ${plan.shortName} after trial`;
    } else if (providerUpdate && experience?.effectivePlan === "BASIC" && plan.id === "PRO") {
        buttonLabel = "Upgrade to Standard";
    } else if (providerUpdate && experience?.effectivePlan === "STANDARD" && plan.id === "BASIC") {
        buttonLabel = "Change to Basic at renewal";
    } else if (providerUpdate) buttonLabel = `Change to ${plan.shortName}`;
    else if (!checkoutReady && requiresCheckout) buttonLabel = "Loading checkout...";

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
                {isAuthorizedAfterTrial ? (
                    <span className="rounded-full border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] px-2 py-1 text-[10px] font-semibold uppercase text-[color:var(--ui-badge-success-text)]">
                        Authorized after trial
                    </span>
                ) : isSelectedAfterTrial ? (
                    <span className="rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-2 py-1 text-[10px] font-semibold uppercase text-[color:var(--ui-badge-cyan-text)]">
                        Selected after trial
                    </span>
                ) : null}
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
