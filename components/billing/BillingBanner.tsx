"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { AlertTriangle, Clock3, CreditCard, X } from "lucide-react";
import type { BillingExperience } from "@/types/billingExperience";

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

export function BillingBanner({ experience }: { experience: BillingExperience }) {
  const dismissible = experience.customerState === "TRIAL_ACTIVE"
    && experience.accessMode === "FULL"
    && experience.activeOperation == null;
  const dismissalKey = `lablords:billing-banner:trial:${experience.organizationId}`;
  const dismissed = useSyncExternalStore(
    subscribeToDismissals,
    () => readDismissal(dismissalKey),
    // Avoid flashing a previously dismissed informational banner during hydration.
    () => true
  );

  if (experience.accessMode === "READ_ONLY") return null;
  const show = experience.effectivePlan === "STANDARD_TRIAL" || experience.accessMode === "WARNING" || experience.activeOperation;
  if (!show) return null;
  if (dismissible && dismissed) return null;

  const Icon = experience.accessMode === "WARNING" ? AlertTriangle : experience.activeOperation ? CreditCard : Clock3;
  const billingHref = `/org/${encodeURIComponent(experience.organizationId)}/settings#billing`;
  const actionLabel = experience.paymentAction === "AUTHORIZE_CARD" && experience.selectedPostTrialPlan
    ? `Authorize ${experience.selectedPostTrialPlan === "STANDARD" ? "Standard" : "Basic"}`
      : experience.paymentAction === "CHOOSE_PLAN"
      ? "Choose plan"
      : "Manage billing";

  const dismiss = () => {
    writeDismissal(dismissalKey);
  };

  return (
    <div className="relative mb-4 flex flex-col gap-3 rounded-[var(--ui-radius-control)] border border-amber-500/30 bg-amber-500/10 px-4 py-3 pr-11 text-sm sm:flex-row sm:items-center sm:justify-between sm:pr-12" role="status">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div>
          <p className="font-semibold text-[color:var(--ui-text)]">{experience.customerMessage}</p>
          {experience.trialEndsAt && <p className="mt-0.5 text-xs text-[color:var(--ui-text-muted)]">Standard trial ends {new Date(experience.trialEndsAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}.</p>}
        </div>
      </div>
      {experience.viewer.canManageBilling && experience.paymentAction !== "NONE" && (
        <Link className="shrink-0 font-semibold text-amber-600 hover:underline" href={billingHref}>{actionLabel}</Link>
      )}
      {dismissible && (
        <button
          type="button"
          className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-[var(--ui-radius-control)] text-[color:var(--ui-text-muted)] transition-colors hover:bg-amber-500/10 hover:text-[color:var(--ui-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
          onClick={dismiss}
          aria-label="Dismiss trial reminder for this session"
          title="Dismiss for this session"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
