import {
  CreditCard,
  Landmark,
  ShieldCheck,
  Smartphone,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { AppButton } from "@/components/ui";
import type { BillingOverview, OrganizationSubscriptionDto } from "@/lib/api/billing";
import {
  getProviderPaymentMethodLabel,
  type SupportedRecurringPaymentMethod,
} from "@/lib/billingPaymentMethods";

type BillingPaymentMethodsOverviewProps = {
  availability?: BillingOverview["checkoutMethodAvailability"];
  currentMethod?: OrganizationSubscriptionDto["providerPaymentMethod"] | null;
  canChangeMethod?: boolean;
  changeDisabled?: boolean;
  changeLoading?: boolean;
  onChangeMethod?: () => void;
};

type MethodDetail = {
  method: SupportedRecurringPaymentMethod;
  icon: LucideIcon;
  description: string;
};

const METHOD_DETAILS: MethodDetail[] = [
  {
    method: "CARD",
    icon: CreditCard,
    description: "Authorize with a supported debit or credit card.",
  },
  {
    method: "UPI",
    icon: Smartphone,
    description: "Approve UPI AutoPay in a supported app on mobile or through Razorpay QR on desktop.",
  },
  {
    method: "EMANDATE",
    icon: Landmark,
    description: "Set up a bank mandate using netbanking, debit card, or Aadhaar. Bank confirmation can take longer.",
  },
];

const CARD_ONLY_AVAILABILITY: NonNullable<BillingOverview["checkoutMethodAvailability"]> = {
  mode: "CARD_ONLY",
  potentialMethods: ["CARD"],
  providerControlsVisibility: false,
};

export function BillingPaymentMethodsOverview({
  availability,
  currentMethod,
  canChangeMethod = false,
  changeDisabled = false,
  changeLoading = false,
  onChangeMethod,
}: BillingPaymentMethodsOverviewProps) {
  const resolvedAvailability = availability ?? CARD_ONLY_AVAILABILITY;
  const providerManaged = resolvedAvailability.mode === "PROVIDER_MANAGED"
    && resolvedAvailability.providerControlsVisibility;
  const potentialMethods = new Set(resolvedAvailability.potentialMethods);
  const currentMethodLabel = currentMethod
    ? getProviderPaymentMethodLabel(currentMethod)
    : null;

  return (
    <section className="px-5 py-5" aria-labelledby="billing-payment-methods-title">
      <div className="overflow-hidden rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)]">
        <div className="flex flex-col gap-4 border-b border-[color:var(--ui-form-section-divider)] bg-[color:var(--ui-form-muted-surface-bg)] p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] text-[color:var(--ui-form-accent)]">
              <WalletCards size={19} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
                Payment methods
              </p>
              <h3 id="billing-payment-methods-title" className="mt-1 text-base font-semibold text-[color:var(--text-primary)]">
                {providerManaged ? "Choose securely in Razorpay Checkout" : "Card checkout is currently active"}
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-[color:var(--text-secondary)]">
                {providerManaged
                  ? "After reviewing your plan, Razorpay shows the recurring methods eligible for this account, amount, bank or app, and device."
                  : "This environment is still in card-only rollout mode. UPI AutoPay and eMandate appear after multi-method checkout and the corresponding Razorpay account capabilities are enabled."}
              </p>
            </div>
          </div>
          <span className="inline-flex w-fit shrink-0 items-center rounded-full border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--ui-badge-cyan-text)]">
            {providerManaged ? "Razorpay managed" : "Card-only mode"}
          </span>
        </div>

        {currentMethodLabel ? (
          <div className="flex flex-col gap-3 border-b border-[color:var(--ui-form-section-divider)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-[color:var(--text-muted)]">Current recurring method</p>
              <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">{currentMethodLabel}</p>
            </div>
            {canChangeMethod && onChangeMethod ? (
              <AppButton
                variant="secondary"
                size="sm"
                disabled={changeDisabled || changeLoading}
                isLoading={changeLoading}
                onClick={onChangeMethod}
              >
                Change payment method
              </AppButton>
            ) : null}
          </div>
        ) : null}

        <ul className="grid divide-y divide-[color:var(--ui-form-section-divider)] sm:grid-cols-3 sm:divide-x sm:divide-y-0" aria-label="Supported recurring payment methods">
          {METHOD_DETAILS.map(({ method, icon: Icon, description }) => {
            const isCurrent = currentMethod === method;
            const isPotential = potentialMethods.has(method);
            const status = isCurrent
              ? "Current"
              : providerManaged && isPotential
                ? "Razorpay decides"
                : isPotential
                  ? "Enabled"
                  : "Not enabled";
            const statusClasses = isCurrent || (!providerManaged && isPotential)
              ? "border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] text-[color:var(--ui-badge-success-text)]"
              : providerManaged && isPotential
                ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] text-[color:var(--text-muted)]";

            return (
              <li key={method} className="min-w-0 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[color:var(--ui-form-muted-surface-bg)] text-[color:var(--text-primary)]">
                    <Icon size={16} aria-hidden="true" />
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClasses}`}>
                    {status}
                  </span>
                </div>
                <p className="mt-3 text-sm font-semibold text-[color:var(--text-primary)]">
                  {getProviderPaymentMethodLabel(method)}
                </p>
                <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">{description}</p>
              </li>
            );
          })}
        </ul>

        <div className="flex items-start gap-2.5 border-t border-[color:var(--ui-form-section-divider)] bg-[color:var(--ui-form-muted-surface-bg)] px-4 py-3 text-xs leading-5 text-[color:var(--text-secondary)]">
          <ShieldCheck className="mt-0.5 shrink-0 text-[color:var(--ui-form-accent)]" size={15} aria-hidden="true" />
          <p>
            Payment credentials and approvals stay inside Razorpay. Lab Lords records only provider-confirmed mandate and payment status.
          </p>
        </div>
      </div>
    </section>
  );
}
