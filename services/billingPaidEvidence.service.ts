import type { Prisma } from "@/app/generated/prisma/client";
import {
  COMMERCIAL_EVIDENCE_VERSION,
  readCommercialIntentSnapshot,
} from "@/services/billingCommercialEvidence.service";

/**
 * Loads only the stored provider evidence needed to decide whether paid access
 * has a trustworthy current boundary. The most recent evidence row must also
 * be the row named by the subscription's immutable confirmation pointers.
 */
export const BILLING_PAID_EVIDENCE_INCLUDE = {
  billingOffer: {
    select: {
      id: true,
      providerMode: true,
      razorpayOfferId: true,
    },
  },
  replacesSubscription: {
    select: {
      id: true,
      organizationId: true,
      providerMode: true,
      razorpaySubscriptionId: true,
    },
  },
  invoices: {
    where: { commercialEvidenceVersion: COMMERCIAL_EVIDENCE_VERSION },
    orderBy: [
      { periodEnd: "desc" as const },
      { createdAt: "desc" as const },
    ],
    take: 1,
    include: { commercialIntentChange: true },
  },
} satisfies Prisma.OrganizationSubscriptionInclude;

export type BillingPaidEvidenceSubscription = Prisma.OrganizationSubscriptionGetPayload<{
  include: typeof BILLING_PAID_EVIDENCE_INCLUDE;
}>;

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isExactId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isCanonicalCurrency(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Z]{3}$/.test(value)
    && value === value.trim();
}

function isCanonicalPeriod(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value === value.toLowerCase();
}

function sameInstant(left: Date | null | undefined, right: Date) {
  return isValidDate(left) && left.getTime() === right.getTime();
}

function intentBindsSubscription(
  subscription: BillingPaidEvidenceSubscription,
  intent: NonNullable<BillingPaidEvidenceSubscription["invoices"][number]["commercialIntentChange"]>,
  authorizedSourceSubscriptionId: string
) {
  const directBinding = intent.organizationSubscriptionId === subscription.id
    && intent.replacementSubscriptionId == null
    && authorizedSourceSubscriptionId === subscription.razorpaySubscriptionId;

  const source = subscription.replacesSubscription;
  const replacementBinding = intent.replacementSubscriptionId === subscription.id
    && isExactId(intent.organizationSubscriptionId)
    && subscription.replacesSubscriptionId === intent.organizationSubscriptionId
    && source?.id === intent.organizationSubscriptionId
    && source.organizationId === subscription.organizationId
    && source.providerMode === subscription.providerMode
    && source.razorpaySubscriptionId === authorizedSourceSubscriptionId;

  return directBinding !== replacementBinding && (directBinding || replacementBinding);
}

function resolveTrustedPaidThroughInternal(
  subscription: BillingPaidEvidenceSubscription | null | undefined,
  now: Date
): Date | null {
  if (!subscription
    || !isValidDate(now)
    || (subscription.providerMode !== "TEST" && subscription.providerMode !== "LIVE")
    || !isValidDate(subscription.paidThrough)
    || subscription.paidThrough.getTime() <= now.getTime()
    || !isExactId(subscription.id)
    || !isExactId(subscription.organizationId)
    || !isExactId(subscription.razorpaySubscriptionId)
    || !isExactId(subscription.razorpayPlanId)
    || !isPositiveSafeInteger(subscription.quantity)
    || !isPositiveSafeInteger(subscription.amountSubunits)
    || !isCanonicalCurrency(subscription.currency)
    || !isCanonicalPeriod(subscription.period)
    || !isPositiveSafeInteger(subscription.interval)
    || !isExactId(subscription.lastConfirmedInvoiceId)
    || !isExactId(subscription.lastConfirmedPaymentId)
    || !isValidDate(subscription.lastPaymentConfirmedAt)
    || !isExactId(subscription.confirmedCommercialIntentChangeId)
    || subscription.invoices.length !== 1) {
    return null;
  }

  const evidence = subscription.invoices[0];
  const intent = evidence.commercialIntentChange;
  if (!intent
    || evidence.commercialEvidenceVersion !== COMMERCIAL_EVIDENCE_VERSION
    || evidence.evidenceFailureCode != null
    || evidence.organizationId !== subscription.organizationId
    || evidence.organizationSubscriptionId !== subscription.id
    || evidence.razorpayInvoiceId !== subscription.lastConfirmedInvoiceId
    || evidence.razorpayPaymentId !== subscription.lastConfirmedPaymentId
    || evidence.commercialIntentChangeId !== subscription.confirmedCommercialIntentChangeId
    || intent.id !== subscription.confirmedCommercialIntentChangeId
    || intent.organizationId !== subscription.organizationId
    || intent.status !== "APPLIED"
    || intent.operationStatus !== "APPLIED"
    || intent.failureCategory != null
    || intent.failureCode != null
    || !isValidDate(intent.appliedAt)
    || !isValidDate(intent.providerConfirmedAt)
    || evidence.providerMode !== subscription.providerMode
    || evidence.razorpaySubscriptionId !== subscription.razorpaySubscriptionId
    || evidence.razorpayPlanId !== subscription.razorpayPlanId
    || evidence.providerQuantity !== subscription.quantity
    || !isValidDate(evidence.periodStart)
    || !isValidDate(evidence.periodEnd)
    || evidence.periodStart.getTime() > now.getTime()
    || evidence.periodEnd.getTime() <= evidence.periodStart.getTime()
    || !sameInstant(evidence.periodEnd, subscription.paidThrough)
    || !sameInstant(subscription.currentStart, evidence.periodStart)
    || !sameInstant(subscription.currentEnd, evidence.periodEnd)
    || !isValidDate(evidence.paidAt)
    || !isValidDate(evidence.evidenceConfirmedAt)
    || evidence.evidenceConfirmedAt.getTime() < evidence.paidAt.getTime()
    || subscription.lastPaymentConfirmedAt.getTime() < evidence.evidenceConfirmedAt.getTime()) {
    return null;
  }

  const frozen = readCommercialIntentSnapshot(intent, {
    requireBoundSubscription: true,
  });
  if (!isValidDate(frozen.commercialIntentCapturedAt)
    || evidence.paidAt.getTime() < frozen.commercialIntentCapturedAt.getTime()
    || frozen.authorizedProviderMode !== subscription.providerMode
    || !isExactId(frozen.authorizedSourceRazorpaySubscriptionId)
    || frozen.authorizedRazorpaySubscriptionId !== subscription.razorpaySubscriptionId
    || frozen.authorizedRazorpayPlanId !== subscription.razorpayPlanId
    || frozen.authorizedPlan !== subscription.plan
    || (intent.toPlan != null && intent.toPlan !== frozen.authorizedPlan)
    || frozen.authorizedQuantity !== subscription.quantity
    || (intent.toQuantity != null && intent.toQuantity !== frozen.authorizedQuantity)
    || frozen.authorizedUnitAmountSubunits !== subscription.amountSubunits
    || !isPositiveSafeInteger(frozen.authorizedUnitAmountSubunits)
    || !isPositiveSafeInteger(frozen.authorizedGrossAmountSubunits)
    || frozen.authorizedGrossAmountSubunits
      !== frozen.authorizedUnitAmountSubunits * frozen.authorizedQuantity
    || !isPositiveSafeInteger(frozen.authorizedExpectedAmountSubunits)
    || frozen.authorizedExpectedAmountSubunits > frozen.authorizedGrossAmountSubunits
    || frozen.authorizedCurrency !== subscription.currency
    || !isCanonicalCurrency(frozen.authorizedCurrency)
    || frozen.authorizedPeriod !== subscription.period
    || !isCanonicalPeriod(frozen.authorizedPeriod)
    || frozen.authorizedInterval !== subscription.interval
    || !intentBindsSubscription(
      subscription,
      intent,
      frozen.authorizedSourceRazorpaySubscriptionId
    )) {
    return null;
  }

  const offerId = frozen.authorizedRazorpayOfferId;
  if (offerId == null) {
    if (frozen.authorizedOfferValidThroughPaidCount != null
      || frozen.authorizedExpectedAmountSubunits !== frozen.authorizedGrossAmountSubunits
      || evidence.razorpayOfferId != null
      || subscription.billingOfferId != null
      || subscription.billingOffer != null) {
      return null;
    }
  } else if (!isExactId(offerId)
    || !isPositiveSafeInteger(frozen.authorizedOfferValidThroughPaidCount)
    || frozen.authorizedExpectedAmountSubunits >= frozen.authorizedGrossAmountSubunits
    || evidence.razorpayOfferId !== offerId
    || !isExactId(subscription.billingOfferId)
    || subscription.billingOffer?.id !== subscription.billingOfferId
    || subscription.billingOffer.providerMode !== subscription.providerMode
    || subscription.billingOffer.razorpayOfferId !== offerId) {
    return null;
  }

  const allowedSettledAmounts = offerId == null
    ? [frozen.authorizedExpectedAmountSubunits]
    : [frozen.authorizedExpectedAmountSubunits, frozen.authorizedGrossAmountSubunits];
  if (evidence.status !== "paid"
    || evidence.paymentStatus !== "captured"
    || evidence.paymentCaptured !== true
    || !isPositiveSafeInteger(evidence.amountSubunits)
    || !allowedSettledAmounts.includes(evidence.amountSubunits)
    || !isNonNegativeSafeInteger(evidence.amountPaidSubunits)
    || evidence.amountPaidSubunits !== evidence.amountSubunits
    || !isNonNegativeSafeInteger(evidence.amountDueSubunits)
    || evidence.amountDueSubunits !== 0
    || evidence.paymentAmountSubunits !== evidence.amountSubunits
    || !isCanonicalCurrency(evidence.currency)
    || evidence.currency !== frozen.authorizedCurrency
    || !isCanonicalCurrency(evidence.paymentCurrency)
    || evidence.paymentCurrency !== frozen.authorizedCurrency) {
    return null;
  }

  return new Date(subscription.paidThrough.getTime());
}

/**
 * Returns a paid-access boundary only when every stored pointer and immutable
 * commercial tuple proves the current provider-settled period. Any missing or
 * malformed state fails closed without surfacing an exception to callers.
 */
export function resolveTrustedPaidThrough(
  subscription: BillingPaidEvidenceSubscription | null | undefined,
  now: Date = new Date()
): Date | null {
  try {
    return resolveTrustedPaidThroughInternal(subscription, now);
  } catch {
    return null;
  }
}
