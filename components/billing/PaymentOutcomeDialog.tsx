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

const OUTCOME_COPY: Record<PaymentOutcome["status"], { title: string; body: string; retryLabel: string }> = {
  ABANDONED: {
    title: "Authorization was not completed",
    body: "Your trial or current confirmed plan remains unchanged. You can authorize the selected plan whenever you are ready.",
    retryLabel: "Retry authorization",
  },
  DECLINED: {
    title: "The payment authorization was declined",
    body: "Check your payment details or try another supported recurring payment method. Your trial or current confirmed plan remains unchanged.",
    retryLabel: "Try another payment method",
  },
  FAILED: {
    title: "Razorpay could not complete the authorization",
    body: "A bank, network, or provider error interrupted the request. No confirmed billing change was applied.",
    retryLabel: "Retry authorization",
  },
  AWAITING_PROVIDER_CONFIRMATION: {
    title: "Confirmation is taking longer than usual",
    body: "We are checking Razorpay before changing any billing state. You can continue to the confirmation page safely.",
    retryLabel: "Check confirmation",
  },
};

const RECOVERY_OUTCOME_COPY: typeof OUTCOME_COPY = {
  ABANDONED: {
    title: "Payment method update was not completed",
    body: "Your current confirmed access remains unchanged. You can reauthorize the recurring payment mandate whenever you are ready.",
    retryLabel: "Update payment method",
  },
  DECLINED: {
    title: "The payment method update was declined",
    body: "Check your payment details or try another supported recurring payment method. Access is restored only after Razorpay confirms the renewal payment.",
    retryLabel: "Try another payment method",
  },
  FAILED: {
    title: "Razorpay could not update the payment method",
    body: "A bank, network, or provider error interrupted recovery. No unconfirmed access change was applied.",
    retryLabel: "Retry payment method update",
  },
  AWAITING_PROVIDER_CONFIRMATION: {
    title: "Recovery confirmation is taking longer than usual",
    body: "We are checking Razorpay for the mandate update and renewal payment before restoring access.",
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
          <Icon className="mt-0.5 h-6 w-6 shrink-0 text-amber-500" aria-hidden="true" />
          <div>
            <h2 id="payment-outcome-title" className="text-lg font-bold text-[color:var(--ui-dialog-title)]">{copy.title}</h2>
            <p className="mt-2 text-sm text-[color:var(--ui-dialog-description)]">{outcome.message || copy.body}</p>
            {outcome.status === "DECLINED" && (
              <p className="mt-2 text-xs text-[color:var(--ui-text-muted)]">If the provider response was unclear, check your bank statement before retrying.</p>
            )}
          </div>
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
