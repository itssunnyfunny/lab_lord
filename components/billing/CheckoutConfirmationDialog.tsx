"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CreditCard, ShieldCheck, X } from "lucide-react";
import { AppButton } from "@/components/ui";

type CheckoutConfirmationDialogProps = {
  isOpen: boolean;
  loading: boolean;
  purpose?: "PLAN" | "RECOVERY";
  planName: "Basic" | "Standard";
  unitAmount: number;
  quantity: number;
  monthlyTotal: number;
  trialActive: boolean;
  changeTiming: "AUTHORIZATION" | "FUTURE_TRIAL" | "IMMEDIATE_PRORATION" | "NEXT_CYCLE";
  trialEndsAt: string | null;
  providerChargeAt: string | null;
  effectiveAt: string | null;
  planFeeDueToday: number;
  contactEmail?: string | null;
  contactPhone?: string | null;
  testMode: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
};

const formatInr = (amount: number) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
}).format(amount);

const formatDate = (value: string) => new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(new Date(value));

export function CheckoutConfirmationDialog({
  isOpen,
  loading,
  purpose = "PLAN",
  planName,
  unitAmount,
  quantity,
  monthlyTotal,
  trialActive,
  changeTiming,
  trialEndsAt,
  providerChargeAt,
  effectiveAt,
  planFeeDueToday,
  contactEmail,
  contactPhone,
  testMode,
  onClose,
  onConfirm,
}: CheckoutConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
  }, [isOpen]);

  const closeAndRestoreFocus = useCallback(() => {
    const previouslyFocused = previouslyFocusedRef.current;
    onClose();
    window.setTimeout(() => previouslyFocused?.focus(), 0);
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) closeAndRestoreFocus();
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeAndRestoreFocus, isOpen, loading]);

  if (!isOpen || typeof document === "undefined") return null;

  const providerUpdate = changeTiming !== "AUTHORIZATION";
  const firstPlanCharge = purpose === "RECOVERY"
    ? "Razorpay will update the authorized card and retry the outstanding renewal. Lab Lords restores full access only after the payment and paid period are confirmed."
    : changeTiming === "FUTURE_TRIAL"
    ? providerChargeAt
      ? `Razorpay currently confirms the first plan charge for ${formatDate(providerChargeAt)}. The plan change is applied only after Razorpay confirms it.`
      : "Razorpay will confirm the future subscription charge date before Lab Lords applies this plan change."
    : changeTiming === "NEXT_CYCLE"
      ? effectiveAt
        ? `${planName} will take effect at the next billing cycle on ${formatDate(effectiveAt)}. Your current plan remains active until then.`
        : `${planName} will take effect at the next provider-confirmed billing cycle. Your current plan remains active until then.`
      : changeTiming === "IMMEDIATE_PRORATION"
        ? "Razorpay will calculate and charge the prorated difference before Lab Lords applies the upgrade."
        : trialActive && trialEndsAt
          ? `If card authorization succeeds, Razorpay will schedule the first plan charge for ${formatDate(trialEndsAt)}.`
          : "Razorpay will show the immediate subscription charge before you authorize it.";
  const dueToday = purpose === "RECOVERY"
    ? "Shown by Razorpay"
    : changeTiming === "NEXT_CYCLE" || changeTiming === "FUTURE_TRIAL"
    ? formatInr(0)
    : changeTiming === "IMMEDIATE_PRORATION"
      ? "Calculated by Razorpay"
      : formatInr(planFeeDueToday);
  const title = purpose === "RECOVERY"
    ? "Update card and retry payment"
    : providerUpdate
    ? trialActive
      ? `Change your post-trial plan to ${planName}`
      : `Change your plan to ${planName}`
    : `Authorize ${planName}${trialActive ? " after your trial" : ""}`;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-3 sm:items-center sm:p-4">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-[color:var(--ui-backdrop-bg)] backdrop-blur-sm"
        onClick={loading ? undefined : closeAndRestoreFocus}
        tabIndex={-1}
        aria-label="Close authorization summary"
      />
      <div
        ref={dialogRef}
        className="relative max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-[var(--ui-dialog-radius)] border border-[color:var(--ui-dialog-border)] bg-[color:var(--ui-dialog-bg)] p-4 shadow-[var(--ui-dialog-shadow)] sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-confirmation-title"
        tabIndex={-1}
      >
        <div className="flex items-start gap-3 pr-9">
          <div className="rounded-full bg-[color:var(--ui-dialog-icon-info-bg)] p-2 text-[color:var(--ui-dialog-icon-info-text)]">
            <CreditCard className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id="checkout-confirmation-title" className="text-lg font-bold text-[color:var(--ui-dialog-title)]">
              {title}
            </h2>
            <p className="mt-1 text-sm text-[color:var(--ui-dialog-description)]">
              {purpose === "RECOVERY"
                ? "Review the current recurring branch billing before opening secure Checkout."
                : "Review the recurring branch billing before confirming this change."}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-[var(--ui-radius-control)] text-[color:var(--ui-text-muted)] hover:bg-[color:var(--ui-form-muted-surface-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
          onClick={closeAndRestoreFocus}
          disabled={loading}
          aria-label="Close authorization summary"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <dl className="mt-5 grid gap-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">
              {purpose === "RECOVERY" ? "Renewal retry" : "Plan fee today"}
            </dt>
            <dd className="mt-1 font-semibold text-[color:var(--ui-text)]">{dueToday}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">
              {purpose === "RECOVERY" ? "Current monthly total" : trialActive ? "After trial" : "Monthly total"}
            </dt>
            <dd className="mt-1 font-semibold text-[color:var(--ui-text)]">{formatInr(monthlyTotal)}/month</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">Branch calculation</dt>
            <dd className="mt-1 text-[color:var(--ui-text)]">{quantity} {quantity === 1 ? "branch" : "branches"} × {formatInr(unitAmount)} per branch</dd>
          </div>
        </dl>

        <div className="mt-4 space-y-3 text-sm text-[color:var(--ui-dialog-description)]">
          <p>{firstPlanCharge}</p>
          {!providerUpdate || purpose === "RECOVERY" ? (
            <>
              <p>Razorpay may make a temporary ₹5 card-verification payment. Razorpay automatically refunds this verification amount.</p>
              <div className="flex gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ui-badge-cyan-text)]" aria-hidden="true" />
                <div className="space-y-1">
                  <p>Phone and email are used for billing notifications and can be edited in Razorpay.</p>
                  <p>Your bank sends the card OTP to the contact registered with that card.</p>
                  {(contactEmail || contactPhone) && (
                    <p className="text-xs text-[color:var(--ui-text-muted)]">Prefill: {[contactEmail, contactPhone].filter(Boolean).join(" · ")}</p>
                  )}
                </div>
              </div>
              {testMode && (
                <p className="rounded-[var(--ui-radius-control)] border border-amber-500/30 bg-amber-500/10 p-3 text-amber-600">
                  Razorpay Test Mode uses a simulated bank page. No real OTP SMS is sent.
                </p>
              )}
            </>
          ) : (
            <div className="flex gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ui-badge-cyan-text)]" aria-hidden="true" />
              <p>Razorpay will apply this plan change using the card already authorized for the workspace.</p>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <AppButton variant="quiet" onClick={closeAndRestoreFocus} disabled={loading}>Not now</AppButton>
          <AppButton variant="primary" onClick={() => void onConfirm()} isLoading={loading}>
            {providerUpdate && purpose !== "RECOVERY" ? "Confirm plan change" : "Continue to Razorpay"}
          </AppButton>
        </div>
      </div>
    </div>,
    document.body
  );
}
