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

const OUTCOME_COPY: Record<PaymentOutcome["status"], { title: string; body: string; retryLabel: string }> = {
  ABANDONED: {
    title: "Authorization was not completed",
    body: "Your trial or current confirmed plan remains unchanged. You can authorize the selected plan whenever you are ready.",
    retryLabel: "Retry authorization",
  },
  DECLINED: {
    title: "The card authorization was declined",
    body: "Check the card details or try another supported card. Your trial or current confirmed plan remains unchanged.",
    retryLabel: "Try another card",
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
    title: "Card update was not completed",
    body: "Your current confirmed access remains unchanged. You can update the payment card whenever you are ready.",
    retryLabel: "Update card",
  },
  DECLINED: {
    title: "The card update was declined",
    body: "Check the card details or try another supported card. Access is restored only after Razorpay confirms the renewal payment.",
    retryLabel: "Try another card",
  },
  FAILED: {
    title: "Razorpay could not update the card",
    body: "A bank, network, or provider error interrupted recovery. No unconfirmed access change was applied.",
    retryLabel: "Retry card update",
  },
  AWAITING_PROVIDER_CONFIRMATION: {
    title: "Recovery confirmation is taking longer than usual",
    body: "We are checking Razorpay for the card update and renewal payment before restoring access.",
    retryLabel: "Check confirmation",
  },
};

export function PaymentOutcomeDialog({ outcome, mode = "AUTHORIZATION", retrying, onRetry, onClose }: PaymentOutcomeDialogProps) {
  const copy = outcome ? (mode === "RECOVERY" ? RECOVERY_OUTCOME_COPY : OUTCOME_COPY)[outcome.status] : null;
  const Icon = outcome?.status === "AWAITING_PROVIDER_CONFIRMATION" ? Clock3 : AlertCircle;

  return (
    <Dialog
      open={Boolean(outcome)}
      onClose={onClose}
      title={copy?.title ?? "Billing result"}
      description={outcome?.message || copy?.body}
      icon={<Icon className="mt-0.5 h-6 w-6 shrink-0 text-amber-500" />}
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
      {outcome?.status === "DECLINED" && (
        <p className="text-xs text-[color:var(--ui-text-muted)]">
          If the provider response was unclear, check your bank statement before retrying.
        </p>
      )}
    </Dialog>
  );
}
