"use client";

import { Building2, CreditCard, ShieldCheck, Smartphone, WalletCards } from "lucide-react";
import { AppButton, Dialog } from "@/components/ui";

type CheckoutConfirmationDialogProps = {
  isOpen: boolean;
  loading: boolean;
  purpose?: "PLAN" | "RECOVERY" | "REPLACEMENT";
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
  multiMethodEnabled?: boolean;
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

export function getCheckoutPaymentMethodCopy(multiMethodEnabled: boolean) {
  return multiMethodEnabled
    ? {
        heading: "Choose securely in Razorpay",
        description: "Razorpay Checkout will show the recurring methods eligible for your account, amount, bank or app, and device.",
        methods: ["Card", "UPI AutoPay", "eMandate"] as const,
      }
    : {
        heading: "Authorize securely in Razorpay",
        description: "Card mandate authorization is currently enabled for this workspace. Payment details are entered only in Razorpay Checkout.",
        methods: ["Card"] as const,
      };
}

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
  multiMethodEnabled = false,
  onClose,
  onConfirm,
}: CheckoutConfirmationDialogProps) {
  const providerUpdate = changeTiming !== "AUTHORIZATION";
  const opensCheckout = purpose === "RECOVERY" || purpose === "REPLACEMENT" || !providerUpdate;
  const paymentMethodCopy = getCheckoutPaymentMethodCopy(multiMethodEnabled);
  const firstPlanCharge = purpose === "RECOVERY"
    ? "Razorpay will reauthorize your recurring payment mandate and retry the outstanding renewal. Lab Lords restores full access only after the payment and paid period are confirmed."
    : purpose === "REPLACEMENT"
      ? "Razorpay will authorize a replacement mandate now. Upgrades and branch additions become available after mandate confirmation at no extra charge for the current cycle; recurring billing changes at the next safe-cycle cutover. Downgrades wait until cutover."
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
          ? `If payment mandate authorization succeeds, Razorpay will schedule the first plan charge for ${formatDate(trialEndsAt)}.`
          : "Razorpay will show the immediate subscription charge before you authorize it.";
  const dueToday = purpose === "RECOVERY"
    ? "Shown by Razorpay"
    : purpose === "REPLACEMENT"
      ? formatInr(0)
    : changeTiming === "NEXT_CYCLE" || changeTiming === "FUTURE_TRIAL"
    ? formatInr(0)
    : changeTiming === "IMMEDIATE_PRORATION"
      ? "Calculated by Razorpay"
      : formatInr(planFeeDueToday);
  const title = purpose === "RECOVERY"
    ? "Update payment method and retry payment"
    : purpose === "REPLACEMENT"
      ? `Authorize a replacement mandate for ${planName}`
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
        ? "Review the renewal and securely reauthorize your recurring payment method."
        : purpose === "REPLACEMENT"
          ? "Review the replacement mandate and when the billing change will take effect."
          : opensCheckout
            ? "Review the subscription before continuing to secure Razorpay Checkout."
            : "Review the subscription change before confirming it."}
      icon={(
        <div className="rounded-full bg-[color:var(--ui-dialog-icon-info-bg)] p-2 text-[color:var(--ui-dialog-icon-info-text)]">
          <WalletCards className="h-5 w-5" aria-hidden="true" />
        </div>
      )}
      closeLabel="Close authorization summary"
      closeDisabled={loading}
      className="max-w-lg"
      footer={(
        <>
          <AppButton variant="quiet" onClick={onClose} disabled={loading} data-dialog-initial-focus>Not now</AppButton>
          <AppButton variant="primary" onClick={() => void onConfirm()} isLoading={loading}>
            {opensCheckout ? "Continue to Razorpay" : "Confirm plan change"}
          </AppButton>
        </>
      )}
    >
        {opensCheckout ? (
          <section
            className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-4"
            aria-labelledby="checkout-payment-methods-title"
          >
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--ui-badge-cyan-text)]" aria-hidden="true" />
              <div>
                <h3 id="checkout-payment-methods-title" className="text-sm font-semibold text-[color:var(--ui-text)]">
                  {paymentMethodCopy.heading}
                </h3>
                <p className="mt-1 text-xs leading-5 text-[color:var(--ui-dialog-description)]">
                  {paymentMethodCopy.description}
                </p>
              </div>
            </div>
            <ul className={`mt-3 grid gap-2 ${multiMethodEnabled ? "sm:grid-cols-3" : "sm:grid-cols-1"}`} aria-label="Recurring payment methods">
              {paymentMethodCopy.methods.map(method => {
                const MethodIcon = method === "UPI AutoPay" ? Smartphone : method === "eMandate" ? Building2 : CreditCard;
                return (
                  <li
                    key={method}
                    className="flex items-center gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-dialog-bg)] px-3 py-2.5 text-sm font-semibold text-[color:var(--ui-text)]"
                  >
                    <MethodIcon className="h-4 w-4 text-[color:var(--ui-badge-cyan-text)]" aria-hidden="true" />
                    {method}
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-[color:var(--ui-text-muted)]">
              Selection and authorization happen inside Razorpay. Lab Lords never collects your card, UPI, or bank credentials.
            </p>
          </section>
        ) : null}

        <section className="mt-5" aria-labelledby="checkout-billing-summary-title">
          <h3 id="checkout-billing-summary-title" className="text-sm font-semibold text-[color:var(--ui-text)]">Billing summary</h3>
          <dl className="mt-2 grid gap-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">
                {purpose === "RECOVERY" ? "Renewal retry" : purpose === "REPLACEMENT" ? "Lab Lords charge today" : "Plan fee today"}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-[color:var(--ui-text)]">{dueToday}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">
                {purpose === "RECOVERY" ? "Current monthly total" : trialActive ? "After trial" : "Monthly total"}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-[color:var(--ui-text)]">{formatInr(monthlyTotal)}/month</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--ui-text-muted)]">Branch calculation</dt>
              <dd className="mt-1 text-sm text-[color:var(--ui-text)]">{quantity} {quantity === 1 ? "branch" : "branches"} × {formatInr(unitAmount)} per branch</dd>
            </div>
          </dl>
        </section>

        <section className="mt-5" aria-labelledby="checkout-next-step-title">
          <h3 id="checkout-next-step-title" className="text-sm font-semibold text-[color:var(--ui-text)]">What happens next</h3>
          <p className="mt-2 text-sm leading-6 text-[color:var(--ui-dialog-description)]">{firstPlanCharge}</p>
          {opensCheckout ? (
            <>
              <div className="mt-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-3 text-xs leading-5 text-[color:var(--ui-dialog-description)]">
                <p className="font-semibold text-[color:var(--ui-text)]">Method-specific authorization</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4">
                  <li>If you choose a card, Razorpay may make a temporary ₹5 verification payment and automatically refund it.</li>
                  {multiMethodEnabled ? (
                    <>
                      <li>UPI AutoPay authorization opens a supported UPI app on mobile or a Razorpay QR flow on desktop.</li>
                      <li>eMandate authorization may use netbanking, debit card, or Aadhaar and can remain pending while the bank completes registration.</li>
                    </>
                  ) : null}
                </ul>
                <p className="mt-2 text-[color:var(--ui-text-muted)]">
                  The editable phone and email are billing-contact defaults for Razorpay notifications. They do not determine the account, app, number, or device used to authorize your chosen payment method.
                </p>
                <p className="mt-1 text-[color:var(--ui-text-muted)]">If you choose a card, any bank or 3-D Secure OTP is controlled by the card issuer and sent to the mobile number, email, or device registered with that issuer.</p>
                <p className="mt-1 text-[color:var(--ui-text-muted)]">If you choose a card, Lab Lords does not ask Razorpay to remember it for one-click payments.</p>
                {(contactEmail || contactPhone) && (
                  <p className="mt-1 text-[color:var(--ui-text-muted)]">Billing contact: {[contactEmail, contactPhone].filter(Boolean).join(" · ")}</p>
                )}
              </div>
              {testMode && (
                <p className="mt-3 rounded-[var(--ui-radius-control)] border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-600">
                  {multiMethodEnabled
                    ? "Razorpay Test Mode simulates bank or app authentication. No real card OTP, UPI mandate approval, SMS, or email is sent."
                    : "Razorpay Test Mode simulates bank authentication. No real card OTP, SMS, or email is sent."}
                </p>
              )}
            </>
          ) : (
            <div className="mt-3 flex gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ui-badge-cyan-text)]" aria-hidden="true" />
              <p className="text-sm text-[color:var(--ui-dialog-description)]">Razorpay will apply this plan change using the recurring payment mandate already authorized for the workspace.</p>
            </div>
          )}
        </section>

    </Dialog>
  );
}
