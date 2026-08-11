"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Clock3, X } from "lucide-react";
import { AppButton } from "@/components/ui";
import type { RazorpayCheckoutMode } from "@/components/billing/RazorpayCheckoutLauncher";

export type PaymentOutcome = {
  status: "ABANDONED" | "DECLINED" | "FAILED" | "AWAITING_PROVIDER_CONFIRMATION";
  message?: string;
};

type PaymentOutcomeDialogProps = {
  outcome: PaymentOutcome | null;
  mode?: RazorpayCheckoutMode;
  retrying: boolean;
  onRetry: () => void | Promise<void>;
  onClose: () => void;
};

type PaymentOutcomeCopy = {
  title: string;
  body: string;
  nextStep: string;
  retryLabel: string;
};

const OUTCOME_COPY: Record<PaymentOutcome["status"], PaymentOutcomeCopy> = {
  ABANDONED: {
    title: "Authorization was not completed",
    body: "Your trial or current confirmed plan remains unchanged. No billing change was applied.",
    nextStep: "Return to Razorpay when you are ready to authorize the selected plan.",
    retryLabel: "Retry authorization",
  },
  DECLINED: {
    title: "The payment authorization was declined",
    body: "Your trial or current confirmed plan remains unchanged. No billing change was applied.",
    nextStep: "Check your payment details or try another supported recurring payment method in Razorpay.",
    retryLabel: "Try another payment method",
  },
  FAILED: {
    title: "Razorpay could not complete the authorization",
    body: "A bank, network, or provider error interrupted the request. No confirmed billing change was applied.",
    nextStep: "Try again. Razorpay will show the recurring methods currently eligible for this payment.",
    retryLabel: "Retry authorization",
  },
  AWAITING_PROVIDER_CONFIRMATION: {
    title: "Waiting for Razorpay confirmation",
    body: "We have not changed your billing state while Razorpay confirms the authorization.",
    nextStep: "Check the confirmation again shortly. Do not start another authorization while this one is being verified.",
    retryLabel: "Check confirmation",
  },
};

const RECOVERY_OUTCOME_COPY: typeof OUTCOME_COPY = {
  ABANDONED: {
    title: "Payment method update not completed",
    body: "Your current confirmed access and recurring payment method remain unchanged.",
    nextStep: "Return to Razorpay when you are ready to reauthorize the recurring payment mandate.",
    retryLabel: "Update payment method",
  },
  DECLINED: {
    title: "Payment method update declined",
    body: "The unconfirmed change was not applied. Access is restored only after Razorpay confirms the renewal payment.",
    nextStep: "In Razorpay, review the selected method or choose another eligible recurring payment method.",
    retryLabel: "Try another payment method",
  },
  FAILED: {
    title: "Payment method update interrupted",
    body: "A bank, network, or provider error interrupted recovery. No unconfirmed access change was applied.",
    nextStep: "Try the update again. Razorpay will show the recurring methods currently eligible for recovery.",
    retryLabel: "Retry payment method update",
  },
  AWAITING_PROVIDER_CONFIRMATION: {
    title: "Waiting for recovery confirmation",
    body: "We are checking Razorpay for the mandate update and renewal payment before restoring access.",
    nextStep: "Check the confirmation again shortly. Do not start another recovery attempt while this one is being verified.",
    retryLabel: "Check confirmation",
  },
};

export function getPaymentOutcomeCopy(
  status: PaymentOutcome["status"],
  mode: RazorpayCheckoutMode = "AUTHORIZATION"
) {
  return (mode === "RECOVERY" ? RECOVERY_OUTCOME_COPY : OUTCOME_COPY)[status];
}

export function PaymentOutcomeDialog({ outcome, mode = "AUTHORIZATION", retrying, onRetry, onClose }: PaymentOutcomeDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!outcome) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
  }, [outcome]);

  const closeAndRestoreFocus = useCallback(() => {
    const previouslyFocused = previouslyFocusedRef.current;
    onClose();
    window.setTimeout(() => previouslyFocused?.focus(), 0);
  }, [onClose]);

  useEffect(() => {
    if (!outcome) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [outcome]);

  useEffect(() => {
    if (!outcome) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !retrying) closeAndRestoreFocus();
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
  }, [closeAndRestoreFocus, outcome, retrying]);

  if (!outcome || typeof document === "undefined") return null;
  const copy = getPaymentOutcomeCopy(outcome.status, mode);
  const Icon = outcome.status === "AWAITING_PROVIDER_CONFIRMATION" ? Clock3 : AlertCircle;
  const isAwaitingConfirmation = outcome.status === "AWAITING_PROVIDER_CONFIRMATION";

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-3 sm:items-center sm:p-4">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-[color:var(--ui-backdrop-bg)] backdrop-blur-sm"
        onClick={retrying ? undefined : closeAndRestoreFocus}
        tabIndex={-1}
        aria-label="Close billing result"
      />
      <div
        ref={dialogRef}
        className="relative w-full max-w-sm rounded-[var(--ui-dialog-radius)] border border-[color:var(--ui-dialog-border)] bg-[color:var(--ui-dialog-bg)] p-5 shadow-[var(--ui-dialog-shadow)]"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="payment-outcome-title"
        aria-describedby="payment-outcome-description"
        tabIndex={-1}
      >
        <button
          type="button"
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-[var(--ui-radius-control)] text-[color:var(--ui-text-muted)] hover:bg-[color:var(--ui-form-muted-surface-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
          onClick={closeAndRestoreFocus}
          disabled={retrying}
          aria-label="Close billing result"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="flex items-start gap-3 pr-8">
          <div className={`rounded-full p-2 ${isAwaitingConfirmation ? "bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]" : "bg-amber-500/10 text-amber-500"}`}>
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">
              {mode === "RECOVERY" ? "Payment recovery" : "Payment authorization"}
            </p>
            <h2 id="payment-outcome-title" className="mt-1 text-lg font-bold text-[color:var(--ui-dialog-title)]">{copy.title}</h2>
            <p id="payment-outcome-description" className="mt-2 text-sm leading-6 text-[color:var(--ui-dialog-description)]">{copy.body}</p>
          </div>
        </div>
        {outcome.message && outcome.message !== copy.body ? (
          <div className="mt-4 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-3">
            <p className="text-xs font-semibold text-[color:var(--ui-text)]">Provider detail</p>
            <p className="mt-1 text-xs leading-5 text-[color:var(--ui-dialog-description)]">{outcome.message}</p>
          </div>
        ) : null}
        <div className="mt-4 border-t border-[color:var(--ui-form-surface-border)] pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--ui-text-muted)]">Next step</p>
          <p className="mt-1 text-sm leading-6 text-[color:var(--ui-dialog-description)]">{copy.nextStep}</p>
          {outcome.status === "DECLINED" ? (
            <p className="mt-2 text-xs text-[color:var(--ui-text-muted)]">If the provider response was unclear, check recent bank activity before retrying.</p>
          ) : null}
        </div>
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <AppButton variant="quiet" onClick={closeAndRestoreFocus} disabled={retrying}>Continue</AppButton>
          <AppButton variant="primary" onClick={() => void onRetry()} isLoading={retrying}>{copy.retryLabel}</AppButton>
        </div>
      </div>
    </div>,
    document.body
  );
}
