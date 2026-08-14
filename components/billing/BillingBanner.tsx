"use client";

import Link from "next/link";
import { useId, useSyncExternalStore } from "react";
import { AlertTriangle, Clock3, WalletCards, X } from "lucide-react";
import { BILLING_PAYMENT_ACTION, type BillingExperience } from "@/types/billingExperience";

const dismissalListeners = new Set<() => void>();
const inMemoryDismissals = new Set<string>();

function subscribeToDismissals(listener: () => void) {
  dismissalListeners.add(listener);
  const onStorage = () => listener();
  window.addEventListener("storage", onStorage);
  return () => {
    dismissalListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function readDismissal(key: string) {
  if (inMemoryDismissals.has(key)) return true;
  try {
    return window.sessionStorage.getItem(key) === "dismissed";
  } catch {
    return false;
  }
}

function writeDismissal(key: string) {
  inMemoryDismissals.add(key);
  try {
    window.sessionStorage.setItem(key, "dismissed");
  } catch {
    // The in-memory fallback still dismisses the banner when storage is blocked.
  }
  dismissalListeners.forEach(listener => listener());
}

export function getBillingBannerActionLabel(
  experience: Pick<BillingExperience, "paymentAction" | "selectedPostTrialPlan">
) {
  const authorizationAction = experience.paymentAction === BILLING_PAYMENT_ACTION.AUTHORIZE_PAYMENT_METHOD;
  if (authorizationAction && experience.selectedPostTrialPlan) {
    return `Authorize ${experience.selectedPostTrialPlan === "STANDARD" ? "Standard" : "Basic"}`;
  }
  if (experience.paymentAction === BILLING_PAYMENT_ACTION.UPDATE_PAYMENT_METHOD) {
    return "Update payment method";
  }
  return experience.paymentAction === "CHOOSE_PLAN" ? "Choose plan" : "Manage billing";
}

export function BillingBanner({ experience }: { experience: BillingExperience }) {
  const titleId = useId();
  const hasActiveOperation = experience.hasActiveOperation ?? experience.activeOperation != null;
  const dismissible = experience.customerState === "TRIAL_ACTIVE"
    && experience.accessMode === "FULL"
    && !hasActiveOperation;
  const dismissalKey = `lablords:billing-banner:trial:${experience.organizationId}`;
  const dismissed = useSyncExternalStore(
    subscribeToDismissals,
    () => readDismissal(dismissalKey),
    // Avoid flashing a previously dismissed informational banner during hydration.
    () => true
  );

  if (experience.accessMode === "READ_ONLY") return null;
  const show = experience.effectivePlan === "STANDARD_TRIAL" || experience.accessMode === "WARNING" || hasActiveOperation;
  if (!show) return null;
  if (dismissible && dismissed) return null;

  const isWarning = experience.accessMode === "WARNING";
  const Icon = isWarning ? AlertTriangle : hasActiveOperation ? WalletCards : Clock3;
  const contextLabel = isWarning
    ? "Billing action required"
    : hasActiveOperation
      ? "Billing change in progress"
      : "Standard trial";
  const toneClasses = isWarning
    ? {
        container: "border-amber-500/30 bg-amber-500/10",
        icon: "text-amber-500",
        action: "border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/15",
        dismiss: "hover:bg-amber-500/10",
      }
    : {
        container: "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]",
        icon: "text-[color:var(--ui-badge-cyan-text)]",
        action: "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-form-surface-bg)] text-[color:var(--ui-badge-cyan-text)] hover:bg-[color:var(--ui-form-muted-surface-bg)]",
        dismiss: "hover:bg-[color:var(--ui-form-muted-surface-bg)]",
      };
  const billingHref = `/org/${encodeURIComponent(experience.organizationId)}/settings#billing`;
  const actionLabel = getBillingBannerActionLabel(experience);

  const dismiss = () => {
    writeDismissal(dismissalKey);
  };

  return (
    <section
      className={`relative mb-4 flex flex-col gap-3 rounded-[var(--ui-radius-control)] border px-4 py-3 pr-11 text-sm sm:flex-row sm:items-center sm:justify-between sm:pr-12 ${toneClasses.container}`}
      role="status"
      aria-labelledby={titleId}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${toneClasses.icon}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">{contextLabel}</p>
          <p id={titleId} className="mt-0.5 font-semibold leading-5 text-[color:var(--ui-text)]">{experience.customerMessage}</p>
          {experience.trialEndsAt ? (
            <p className="mt-1 text-xs text-[color:var(--ui-text-muted)]">
              Trial ends {new Date(experience.trialEndsAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}.
            </p>
          ) : null}
        </div>
      </div>
      {experience.viewer.canManageBilling && experience.paymentAction !== "NONE" && (
        <Link
          className={`inline-flex min-h-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] border px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] ${toneClasses.action}`}
          href={billingHref}
        >
          {actionLabel}
        </Link>
      )}
      {dismissible && (
        <button
          type="button"
          className={`absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-[var(--ui-radius-control)] text-[color:var(--ui-text-muted)] transition-colors hover:text-[color:var(--ui-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] ${toneClasses.dismiss}`}
          onClick={dismiss}
          aria-label="Dismiss trial reminder for this session"
          title="Dismiss for this session"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
