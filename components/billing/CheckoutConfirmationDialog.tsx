"use client";

import { CreditCard, ShieldCheck } from "lucide-react";
import { AppButton, Dialog } from "@/components/ui";

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

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={title}
      description={purpose === "RECOVERY"
        ? "Review the current recurring branch billing before opening secure Checkout."
        : "Review the recurring branch billing before confirming this change."}
      icon={(
        <div className="rounded-full bg-[color:var(--ui-dialog-icon-info-bg)] p-2 text-[color:var(--ui-dialog-icon-info-text)]">
          <CreditCard className="h-5 w-5" />
        </div>
      )}
      closeLabel="Close authorization summary"
      closeDisabled={loading}
      className="max-w-lg"
      footer={(
        <>
          <AppButton variant="quiet" onClick={onClose} disabled={loading} data-dialog-initial-focus>Not now</AppButton>
          <AppButton variant="primary" onClick={() => void onConfirm()} isLoading={loading}>
            {providerUpdate && purpose !== "RECOVERY" ? "Confirm plan change" : "Continue to Razorpay"}
          </AppButton>
        </>
      )}
    >
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
                  <p>The editable phone and email are billing-contact defaults for Razorpay notifications. They do not tell Lab Lords which mobile number is registered with your card.</p>
                  <p>Any bank or 3-D Secure OTP is controlled by your card issuer and sent to the mobile number, email, or device registered with that issuer.</p>
                  <p>Lab Lords does not ask Razorpay to remember your card for one-click payments.</p>
                  {(contactEmail || contactPhone) && (
                    <p className="text-xs text-[color:var(--ui-text-muted)]">Editable billing defaults: {[contactEmail, contactPhone].filter(Boolean).join(" · ")}</p>
                  )}
                </div>
              </div>
              {testMode && (
                <p className="rounded-[var(--ui-radius-control)] border border-amber-500/30 bg-amber-500/10 p-3 text-amber-600">
                  Razorpay Test Mode simulates the bank authentication step. No real OTP, SMS, or email is sent.
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

    </Dialog>
  );
}
