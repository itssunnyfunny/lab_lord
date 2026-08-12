"use client";

import { AlertCircle, Clock3 } from "lucide-react";
import { AppButton, Dialog } from "@/components/ui";
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
  const copy = outcome ? getPaymentOutcomeCopy(outcome.status, mode) : null;
  const Icon = outcome?.status === "AWAITING_PROVIDER_CONFIRMATION" ? Clock3 : AlertCircle;
  const isAwaitingConfirmation = outcome?.status === "AWAITING_PROVIDER_CONFIRMATION";

  return (
    <Dialog
      open={Boolean(outcome)}
      onClose={onClose}
      title={copy ? (
        <>
          <span className="block text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">
            {mode === "RECOVERY" ? "Payment recovery" : "Payment authorization"}
          </span>
          <span className="mt-1 block">{copy.title}</span>
        </>
      ) : "Billing result"}
      description={copy?.body}
      icon={(
        <div
          className={`rounded-full p-2 ${
            isAwaitingConfirmation
              ? "bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
              : "bg-amber-500/10 text-amber-500"
          }`}
        >
          <Icon className="h-5 w-5" />
        </div>
      )}
      role="alertdialog"
      closeLabel="Close billing result"
      closeDisabled={retrying}
      className="max-w-sm"
      footer={copy ? (
        <>
          <AppButton variant="quiet" onClick={onClose} disabled={retrying} data-dialog-initial-focus>Continue</AppButton>
          <AppButton variant="primary" onClick={() => void onRetry()} isLoading={retrying}>{copy.retryLabel}</AppButton>
        </>
      ) : undefined}
    >
      {copy && outcome ? (
        <>
          {outcome.message && outcome.message !== copy.body ? (
            <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-3">
              <p className="text-xs font-semibold text-[color:var(--ui-text)]">Provider detail</p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--ui-dialog-description)]">{outcome.message}</p>
            </div>
          ) : null}
          <div className="mt-4 border-t border-[color:var(--ui-form-surface-border)] pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--ui-text-muted)]">Next step</p>
            <p className="mt-1 text-sm leading-6 text-[color:var(--ui-dialog-description)]">{copy.nextStep}</p>
            {outcome.status === "DECLINED" ? (
              <p className="mt-2 text-xs text-[color:var(--ui-text-muted)]">
                If the provider response was unclear, check recent bank activity before retrying.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
