import type { OrganizationSubscriptionDto } from "@/lib/api/billing";
import { getProviderPaymentMethodLabel } from "@/lib/billingPaymentMethods";
import type { BillingExperience } from "@/types/billingExperience";

type BillingPriceSummaryProps = {
  experience: BillingExperience;
  current: OrganizationSubscriptionDto | null;
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

function SummaryRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] px-3 py-2.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--text-muted)]">{label}</dt>
      <dd className="mt-1 font-semibold text-[color:var(--text-primary)]">{value}</dd>
      {detail ? <p className="mt-0.5 text-xs text-[color:var(--text-secondary)]">{detail}</p> : null}
    </div>
  );
}

export function BillingPriceSummary({ experience, current }: BillingPriceSummaryProps) {
  const trialActive = experience.effectivePlan === "STANDARD_TRIAL";
  const paidPlanActive = (experience.effectivePlan === "BASIC" || experience.effectivePlan === "STANDARD")
    && experience.paidThrough != null;
  const selectedPlanName = experience.selectedPostTrialPlan === "STANDARD"
    ? "Standard"
    : experience.selectedPostTrialPlan === "BASIC"
      ? "Basic"
      : null;
  const authorizationLabel = experience.authorizationStatus === "AUTHORIZED"
    ? "Authorized"
    : experience.authorizationStatus === "VERIFYING"
      ? "Verifying with Razorpay"
      : "Not authorized";
  const firstCharge = experience.nextChargeAt
    ? formatDate(experience.nextChargeAt)
    : experience.authorizationStatus === "AUTHORIZED"
      ? "Authorized — Razorpay charge date pending"
      : experience.authorizationStatus === "VERIFYING"
        ? "Waiting for Razorpay confirmation"
        : "Not scheduled — authorize a payment method first";
  const paymentMethodLabel = getProviderPaymentMethodLabel(current?.providerPaymentMethod);

  if (paidPlanActive) {
    const currentPlanName = experience.effectivePlan === "STANDARD" ? "Standard" : "Basic";
    return (
      <section className="space-y-3 px-5 pt-4" aria-labelledby="current-subscription-summary">
        <div>
          <h3 id="current-subscription-summary" className="text-sm font-semibold text-[color:var(--text-primary)]">Current subscription</h3>
          <p className="mt-1 text-xs text-[color:var(--text-secondary)]">Provider-confirmed paid access and renewal details.</p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryRow label="Current plan" value={currentPlanName} />
          <SummaryRow
            label="Monthly branch billing"
            value={`${formatInr(experience.currentMonthlyTotal)}/month`}
            detail={`${experience.confirmedQuantity} ${experience.confirmedQuantity === 1 ? "branch" : "branches"} × ${formatInr(experience.currentUnitAmount)}`}
          />
          <SummaryRow label="Paid through" value={experience.paidThrough ? formatDate(experience.paidThrough) : "Awaiting paid invoice"} />
          <SummaryRow label="Next charge" value={experience.nextChargeAt ? formatDate(experience.nextChargeAt) : "Not scheduled"} />
        </dl>
        {current ? (
          <p className="text-xs text-[color:var(--text-secondary)]">Recurring payment method: {paymentMethodLabel}</p>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className="grid gap-4 px-5 pt-4 lg:grid-cols-2"
      aria-label={trialActive ? "Trial and post-trial billing summary" : "Billing authorization summary"}
    >
      <div className="rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-4">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Current access</h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <SummaryRow label="Access now" value={trialActive ? "Standard trial" : "No active paid plan"} />
          {trialActive ? (
            <SummaryRow label="Plan fee today" value={formatInr(experience.planFeeDueToday)} />
          ) : (
            <SummaryRow label="Billing status" value="No provider-confirmed paid period" />
          )}
          {trialActive && experience.trialEndsAt ? (
            <SummaryRow label="Trial ends" value={formatDate(experience.trialEndsAt)} />
          ) : null}
          <SummaryRow
            label="Workspace access"
            value={experience.accessMode === "READ_ONLY" ? "Read-only" : trialActive ? "Full Standard features" : "Full access"}
          />
        </dl>
      </div>

      <div className="rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-4">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">
          {trialActive ? "After the trial" : "Plan authorization"}
        </h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <SummaryRow label="Selected plan" value={selectedPlanName ?? "Choose a plan"} />
          <SummaryRow
            label="Payment mandate"
            value={authorizationLabel}
            detail={current ? `Recurring method: ${paymentMethodLabel}` : undefined}
          />
          <SummaryRow
            label="Estimated monthly total"
            value={selectedPlanName ? `${formatInr(experience.projectedMonthlyTotal)}/month` : "Choose a plan"}
            detail={selectedPlanName
              ? `${experience.projectedQuantity} ${experience.projectedQuantity === 1 ? "branch" : "branches"} × ${formatInr(experience.projectedUnitAmount)}`
              : undefined}
          />
          <SummaryRow label="First plan charge" value={firstCharge} />
        </dl>
        {trialActive ? (
          <p className="mt-3 text-xs text-[color:var(--text-secondary)]">
            No plan fee is charged during the Standard trial. If you choose a card, Razorpay may make a temporary ₹5 verification payment and automatically refund it.
          </p>
        ) : (
          <p className="mt-3 text-xs text-[color:var(--text-secondary)]">
            Paid access starts only after Razorpay confirms the subscription payment. Your existing data remains preserved while access is inactive.
          </p>
        )}
      </div>
    </section>
  );
}
