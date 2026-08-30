import { toRazorpaySubunits } from "@/lib/razorpay";
import { prisma } from "@/lib/prisma";
import type {
  RazorpayInvoice,
  RazorpayPayment,
  RazorpayPlan,
  RazorpaySubscription,
} from "@/lib/razorpay";
import type {
  BillingOfferDiscountType,
  BillingOfferDurationType,
  OrganizationBillingChange,
  RazorpayMode,
  SaasPlan,
} from "@/app/generated/prisma/client";

export const COMMERCIAL_INTENT_VERSION = 1 as const;
export const COMMERCIAL_EVIDENCE_VERSION = 1 as const;

export type CommercialEvidenceMismatchCode =
  | "COMMERCIAL_INTENT_MISSING"
  | "COMMERCIAL_INTENT_INVALID"
  | "ORGANIZATION_MISMATCH"
  | "PROVIDER_MODE_MISMATCH"
  | "SUBSCRIPTION_MISMATCH"
  | "AUTHORIZED_PLAN_MISMATCH"
  | "PROVIDER_PLAN_MISMATCH"
  | "PROVIDER_PLAN_EVIDENCE_MISSING"
  | "PLAN_AMOUNT_MISMATCH"
  | "BILLING_CADENCE_MISMATCH"
  | "QUANTITY_MISMATCH"
  | "OFFER_MISMATCH"
  | "PAYMENT_ID_MISMATCH"
  | "PAYMENT_SUBSCRIPTION_MISMATCH"
  | "PAYMENT_NOT_AUTHORIZED"
  | "INVOICE_SUBSCRIPTION_MISMATCH"
  | "INVOICE_PAYMENT_MISMATCH"
  | "INVOICE_NOT_PAID"
  | "PAYMENT_NOT_CAPTURED"
  | "INVOICE_AMOUNT_DUE"
  | "INVOICE_NOT_FULLY_PAID"
  | "INVOICE_PAYMENT_AMOUNT_MISMATCH"
  | "EXPECTED_AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "OFFER_CYCLE_EVIDENCE_MISSING"
  | "STALE_SETTLEMENT"
  | "COMMERCIAL_FINALIZATION_FAILED"
  | "BILLING_PERIOD_MISMATCH"
  | "MALFORMED_PROVIDER_EVIDENCE";

export type CommercialIntentRecord = {
  id: string;
  organizationId: string;
  toPlan: SaasPlan | null;
  toQuantity: number | null;
  commercialIntentVersion: number | null;
  commercialIntentCapturedAt: Date | null;
  authorizedProviderMode: RazorpayMode | null;
  authorizedSourceRazorpaySubscriptionId: string | null;
  authorizedRazorpaySubscriptionId: string | null;
  authorizedSourceRazorpayPlanId: string | null;
  authorizedRazorpayPlanId: string | null;
  authorizedPlan: SaasPlan | null;
  authorizedQuantity: number | null;
  authorizedRazorpayOfferId: string | null;
  authorizedUnitAmountSubunits: number | null;
  authorizedGrossAmountSubunits: number | null;
  authorizedExpectedAmountSubunits: number | null;
  authorizedOfferValidThroughPaidCount: number | null;
  authorizedCurrency: string | null;
  authorizedPeriod: string | null;
  authorizedInterval: number | null;
};

type CommercialOfferSnapshotInput = {
  razorpayOfferId: string;
  discountType: BillingOfferDiscountType;
  discountValue: number;
  durationType: BillingOfferDurationType;
  durationCycles: number;
};

export type CommercialIntentSnapshotInput = {
  providerMode: RazorpayMode;
  sourceRazorpaySubscriptionId?: string | null;
  razorpaySubscriptionId: string | null;
  sourceRazorpayPlanId?: string | null;
  razorpayPlanId: string;
  plan: SaasPlan;
  quantity: number;
  unitAmountSubunits: number;
  currency: string;
  period: string;
  interval: number;
  offer?: CommercialOfferSnapshotInput | null;
  capturedAt?: Date;
};

export type CommercialIntentWriteData = {
  commercialIntentVersion: typeof COMMERCIAL_INTENT_VERSION;
  commercialIntentCapturedAt: Date;
  authorizedProviderMode: RazorpayMode;
  authorizedSourceRazorpaySubscriptionId: string;
  authorizedRazorpaySubscriptionId: string | null;
  authorizedSourceRazorpayPlanId: string | null;
  authorizedRazorpayPlanId: string;
  authorizedPlan: SaasPlan;
  authorizedQuantity: number;
  authorizedRazorpayOfferId: string | null;
  authorizedUnitAmountSubunits: number;
  authorizedGrossAmountSubunits: number;
  authorizedExpectedAmountSubunits: number;
  authorizedOfferValidThroughPaidCount: number | null;
  authorizedCurrency: string;
  authorizedPeriod: string;
  authorizedInterval: number;
};

export function readCommercialIntentSnapshot(
  intent: CommercialIntentRecord,
  options: { requireBoundSubscription?: boolean } = {}
): CommercialIntentWriteData {
  if (!isCompleteIntent(intent, options.requireBoundSubscription === true)) {
    throw new Error(commercialEvidenceMessage("COMMERCIAL_INTENT_INVALID"));
  }
  return {
    commercialIntentVersion: COMMERCIAL_INTENT_VERSION,
    commercialIntentCapturedAt: intent.commercialIntentCapturedAt!,
    authorizedProviderMode: intent.authorizedProviderMode!,
    authorizedSourceRazorpaySubscriptionId: intent.authorizedSourceRazorpaySubscriptionId!,
    authorizedRazorpaySubscriptionId: intent.authorizedRazorpaySubscriptionId,
    authorizedSourceRazorpayPlanId: intent.authorizedSourceRazorpayPlanId,
    authorizedRazorpayPlanId: intent.authorizedRazorpayPlanId!,
    authorizedPlan: intent.authorizedPlan!,
    authorizedQuantity: intent.authorizedQuantity!,
    authorizedRazorpayOfferId: intent.authorizedRazorpayOfferId,
    authorizedUnitAmountSubunits: intent.authorizedUnitAmountSubunits!,
    authorizedGrossAmountSubunits: intent.authorizedGrossAmountSubunits!,
    authorizedExpectedAmountSubunits: intent.authorizedExpectedAmountSubunits!,
    authorizedOfferValidThroughPaidCount: intent.authorizedOfferValidThroughPaidCount,
    authorizedCurrency: intent.authorizedCurrency!,
    authorizedPeriod: intent.authorizedPeriod!,
    authorizedInterval: intent.authorizedInterval!,
  };
}

/** Captures a write-once commercial authorization under the exact mutation attempt lease. */
export async function captureProcessingCommercialIntent(input: {
  change: OrganizationBillingChange;
  leaseToken: string;
  intent: CommercialIntentWriteData;
}) {
  if (input.change.commercialIntentVersion != null) {
    readCommercialIntentSnapshot(input.change);
    return input.change;
  }

  return prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization" WHERE "id" = ${input.change.organizationId} FOR UPDATE
    `;
    const organization = await tx.organization.findUnique({
      where: { id: input.change.organizationId },
      select: { billingMutationLeaseToken: true },
    });
    if (organization?.billingMutationLeaseToken !== input.leaseToken) {
      throw new Error("Billing mutation lease was lost before commercial authorization");
    }
    const captured = await tx.organizationBillingChange.updateMany({
      where: {
        id: input.change.id,
        status: "PROCESSING",
        attemptCount: input.change.attemptCount,
        processingStartedAt: input.change.processingStartedAt,
        commercialIntentVersion: null,
      },
      data: input.intent,
    });
    if (captured.count !== 1) {
      throw new Error("Billing mutation changed before commercial authorization was captured");
    }
    return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: input.change.id } });
  });
}

export type ExactCommercialEvidenceResult =
  | {
      kind: "EXACT_SETTLEMENT";
      expectedAmountSubunits: number;
      periodStart: Date;
      periodEnd: Date;
    }
  | { kind: "AUTHORIZATION_ONLY" }
  | { kind: "PENDING" }
  | { kind: "MISMATCH"; code: CommercialEvidenceMismatchCode };

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function normalizedCurrency(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizedNullableId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mismatch(code: CommercialEvidenceMismatchCode): ExactCommercialEvidenceResult {
  return { kind: "MISMATCH", code };
}

export function commercialEvidenceMessage(code: CommercialEvidenceMismatchCode) {
  const messages: Record<CommercialEvidenceMismatchCode, string> = {
    COMMERCIAL_INTENT_MISSING: "The immutable commercial authorization is missing",
    COMMERCIAL_INTENT_INVALID: "The immutable commercial authorization is incomplete or invalid",
    ORGANIZATION_MISMATCH: "The commercial authorization belongs to another organization",
    PROVIDER_MODE_MISMATCH: "The provider mode does not match the commercial authorization",
    SUBSCRIPTION_MISMATCH: "The provider subscription does not match the commercial authorization",
    AUTHORIZED_PLAN_MISMATCH: "The logical plan does not match the commercial authorization",
    PROVIDER_PLAN_MISMATCH: "The provider plan does not match the commercial authorization",
    PROVIDER_PLAN_EVIDENCE_MISSING: "Provider plan evidence is unavailable for settlement",
    PLAN_AMOUNT_MISMATCH: "The provider plan amount or currency does not match the commercial authorization",
    BILLING_CADENCE_MISMATCH: "The provider billing cadence does not match the commercial authorization",
    QUANTITY_MISMATCH: "The provider quantity does not match the commercial authorization",
    OFFER_MISMATCH: "The provider offer does not match the commercial authorization",
    PAYMENT_ID_MISMATCH: "The provider payment does not match the requested payment",
    PAYMENT_SUBSCRIPTION_MISMATCH: "The payment does not belong to the authorized subscription",
    PAYMENT_NOT_AUTHORIZED: "The payment has not authorized the recurring mandate",
    INVOICE_SUBSCRIPTION_MISMATCH: "The invoice does not belong to the authorized subscription",
    INVOICE_PAYMENT_MISMATCH: "The invoice and payment identifiers do not match",
    INVOICE_NOT_PAID: "The invoice is not paid",
    PAYMENT_NOT_CAPTURED: "The invoice payment is not captured",
    INVOICE_AMOUNT_DUE: "The invoice still has an amount due",
    INVOICE_NOT_FULLY_PAID: "The invoice is not fully settled",
    INVOICE_PAYMENT_AMOUNT_MISMATCH: "The invoice and payment amounts do not match",
    EXPECTED_AMOUNT_MISMATCH: "The settled amount does not match the authorized amount",
    CURRENCY_MISMATCH: "The provider currencies do not match the commercial authorization",
    OFFER_CYCLE_EVIDENCE_MISSING: "The provider offer cycle cannot be proven",
    STALE_SETTLEMENT: "The provider settlement predates the commercial authorization",
    COMMERCIAL_FINALIZATION_FAILED: "Exact provider evidence could not be finalized locally",
    BILLING_PERIOD_MISMATCH: "The invoice billing period does not match the provider subscription",
    MALFORMED_PROVIDER_EVIDENCE: "Razorpay returned malformed commercial evidence",
  };
  return messages[code];
}

export function buildCommercialIntentSnapshot(
  input: CommercialIntentSnapshotInput
): CommercialIntentWriteData {
  if (!positiveInteger(input.quantity)
    || !positiveInteger(input.unitAmountSubunits)
    || !positiveInteger(input.interval)) {
    throw new Error("Commercial intent requires positive quantity, amount, and interval values");
  }
  const providerSubscriptionId = normalizedNullableId(input.razorpaySubscriptionId);
  const sourceProviderSubscriptionId = normalizedNullableId(input.sourceRazorpaySubscriptionId)
    ?? providerSubscriptionId;
  const providerPlanId = normalizedNullableId(input.razorpayPlanId);
  const currency = normalizedCurrency(input.currency);
  const period = input.period.trim().toLowerCase();
  if (!sourceProviderSubscriptionId || !providerPlanId || currency.length !== 3 || !period) {
    throw new Error("Commercial intent requires source and plan provider IDs, currency, and billing period");
  }
  const grossAmountSubunits = input.unitAmountSubunits * input.quantity;
  if (!Number.isSafeInteger(grossAmountSubunits) || grossAmountSubunits <= 0) {
    throw new Error("Commercial intent gross amount is outside the supported range");
  }

  let expectedAmountSubunits = grossAmountSubunits;
  let providerOfferId: string | null = null;
  let offerValidThroughPaidCount: number | null = null;
  if (input.offer) {
    providerOfferId = normalizedNullableId(input.offer.razorpayOfferId);
    const offerCycles = input.offer.durationType === "SINGLE_USE"
      ? 1
      : input.offer.durationCycles;
    if (!providerOfferId || !positiveInteger(offerCycles)) {
      throw new Error("Commercial intent offer requires an ID and positive duration");
    }
    const discountSubunits = input.offer.discountType === "PERCENTAGE"
      ? Math.floor(grossAmountSubunits * input.offer.discountValue / 100)
      : toRazorpaySubunits(input.offer.discountValue, currency);
    if (!positiveInteger(discountSubunits) || discountSubunits >= grossAmountSubunits) {
      throw new Error("Commercial intent offer must produce a positive payable amount");
    }
    expectedAmountSubunits = grossAmountSubunits - discountSubunits;
    offerValidThroughPaidCount = offerCycles;
  }

  return {
    commercialIntentVersion: COMMERCIAL_INTENT_VERSION,
    commercialIntentCapturedAt: input.capturedAt ?? new Date(),
    authorizedProviderMode: input.providerMode,
    authorizedSourceRazorpaySubscriptionId: sourceProviderSubscriptionId,
    authorizedRazorpaySubscriptionId: providerSubscriptionId,
    authorizedSourceRazorpayPlanId: normalizedNullableId(input.sourceRazorpayPlanId),
    authorizedRazorpayPlanId: providerPlanId,
    authorizedPlan: input.plan,
    authorizedQuantity: input.quantity,
    authorizedRazorpayOfferId: providerOfferId,
    authorizedUnitAmountSubunits: input.unitAmountSubunits,
    authorizedGrossAmountSubunits: grossAmountSubunits,
    authorizedExpectedAmountSubunits: expectedAmountSubunits,
    authorizedOfferValidThroughPaidCount: offerValidThroughPaidCount,
    authorizedCurrency: currency,
    authorizedPeriod: period,
    authorizedInterval: input.interval,
  };
}

function isCompleteIntent(intent: CommercialIntentRecord, requireBoundSubscription = false) {
  return intent.commercialIntentVersion === COMMERCIAL_INTENT_VERSION
    && intent.commercialIntentCapturedAt instanceof Date
    && intent.authorizedProviderMode != null
    && normalizedNullableId(intent.authorizedSourceRazorpaySubscriptionId) != null
    && (!requireBoundSubscription
      || normalizedNullableId(intent.authorizedRazorpaySubscriptionId) != null)
    && normalizedNullableId(intent.authorizedRazorpayPlanId) != null
    && intent.authorizedPlan != null
    && positiveInteger(intent.authorizedQuantity)
    && positiveInteger(intent.authorizedUnitAmountSubunits)
    && positiveInteger(intent.authorizedGrossAmountSubunits)
    && positiveInteger(intent.authorizedExpectedAmountSubunits)
    && normalizedCurrency(intent.authorizedCurrency).length === 3
    && normalizedNullableId(intent.authorizedPeriod) != null
    && positiveInteger(intent.authorizedInterval)
    && intent.authorizedGrossAmountSubunits
      === intent.authorizedUnitAmountSubunits * intent.authorizedQuantity
    && intent.authorizedExpectedAmountSubunits <= intent.authorizedGrossAmountSubunits
    && (
      (intent.authorizedRazorpayOfferId == null
        && intent.authorizedOfferValidThroughPaidCount == null
        && intent.authorizedExpectedAmountSubunits === intent.authorizedGrossAmountSubunits)
      || (normalizedNullableId(intent.authorizedRazorpayOfferId) != null
        && positiveInteger(intent.authorizedOfferValidThroughPaidCount)
        && intent.authorizedExpectedAmountSubunits < intent.authorizedGrossAmountSubunits)
    );
}

export function validateExactCommercialEvidence(input: {
  intent: CommercialIntentRecord | null;
  organizationId: string;
  providerMode: RazorpayMode;
  localSubscription: {
    organizationId: string;
    providerMode: RazorpayMode;
    razorpaySubscriptionId: string;
  };
  providerSubscription: RazorpaySubscription;
  payment?: RazorpayPayment | null;
  expectedPaymentId?: string | null;
  invoice?: RazorpayInvoice | null;
  providerPlan?: RazorpayPlan | null;
  now?: Date;
}): ExactCommercialEvidenceResult {
  const intent = input.intent;
  if (!intent) return mismatch("COMMERCIAL_INTENT_MISSING");
  if (!isCompleteIntent(intent, true)) return mismatch("COMMERCIAL_INTENT_INVALID");
  if (intent.organizationId !== input.organizationId
    || input.localSubscription.organizationId !== input.organizationId) {
    return mismatch("ORGANIZATION_MISMATCH");
  }
  if (intent.authorizedProviderMode !== input.providerMode
    || input.localSubscription.providerMode !== input.providerMode) {
    return mismatch("PROVIDER_MODE_MISMATCH");
  }
  if (intent.toPlan != null && intent.toPlan !== intent.authorizedPlan) {
    return mismatch("AUTHORIZED_PLAN_MISMATCH");
  }
  if (intent.toQuantity != null && intent.toQuantity !== intent.authorizedQuantity) {
    return mismatch("COMMERCIAL_INTENT_INVALID");
  }
  if (input.providerSubscription.entity !== "subscription"
    || input.providerSubscription.id !== intent.authorizedRazorpaySubscriptionId
    || input.localSubscription.razorpaySubscriptionId !== intent.authorizedRazorpaySubscriptionId) {
    return mismatch("SUBSCRIPTION_MISMATCH");
  }
  if (input.providerSubscription.plan_id !== intent.authorizedRazorpayPlanId) {
    return mismatch("PROVIDER_PLAN_MISMATCH");
  }
  if (input.providerSubscription.quantity !== intent.authorizedQuantity) {
    return mismatch("QUANTITY_MISMATCH");
  }
  if (normalizedNullableId(input.providerSubscription.offer_id)
    !== normalizedNullableId(intent.authorizedRazorpayOfferId)) {
    return mismatch("OFFER_MISMATCH");
  }

  const payment = input.payment ?? null;
  if (payment) {
    if (payment.entity !== "payment" || !positiveInteger(payment.amount)) {
      return mismatch("MALFORMED_PROVIDER_EVIDENCE");
    }
    if (input.expectedPaymentId && payment.id !== input.expectedPaymentId) {
      return mismatch("PAYMENT_ID_MISMATCH");
    }
    if (payment.subscription_id !== intent.authorizedRazorpaySubscriptionId) {
      return mismatch("PAYMENT_SUBSCRIPTION_MISMATCH");
    }
    if (normalizedCurrency(payment.currency) !== intent.authorizedCurrency) {
      return mismatch("CURRENCY_MISMATCH");
    }
  }

  const invoice = input.invoice ?? null;
  if (!invoice) {
    if (!payment) return { kind: "PENDING" };
    if (payment.invoice_id && payment.status.toLowerCase() === "captured") {
      return mismatch("INVOICE_PAYMENT_MISMATCH");
    }
    if (!["authorized", "captured"].includes(payment.status.toLowerCase())) {
      return mismatch("PAYMENT_NOT_AUTHORIZED");
    }
    if (!["created", "authenticated", "active"].includes(
      input.providerSubscription.status.toLowerCase()
    )) {
      return { kind: "PENDING" };
    }
    return { kind: "AUTHORIZATION_ONLY" };
  }
  if (!payment) return mismatch("INVOICE_PAYMENT_MISMATCH");
  if (invoice.entity !== "invoice"
    || !positiveInteger(invoice.amount)
    || !Number.isSafeInteger(invoice.amount_paid)
    || !Number.isSafeInteger(invoice.amount_due)) {
    return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  }
  if (invoice.subscription_id !== intent.authorizedRazorpaySubscriptionId) {
    return mismatch("INVOICE_SUBSCRIPTION_MISMATCH");
  }
  if (invoice.payment_id !== payment.id || payment.invoice_id !== invoice.id) {
    return mismatch("INVOICE_PAYMENT_MISMATCH");
  }
  if (invoice.status.toLowerCase() !== "paid") return mismatch("INVOICE_NOT_PAID");
  if (payment.status.toLowerCase() !== "captured" || payment.captured === false) {
    return mismatch("PAYMENT_NOT_CAPTURED");
  }
  if (invoice.amount_due !== 0) return mismatch("INVOICE_AMOUNT_DUE");
  if (invoice.amount_paid !== invoice.amount) return mismatch("INVOICE_NOT_FULLY_PAID");
  if (payment.amount !== invoice.amount) return mismatch("INVOICE_PAYMENT_AMOUNT_MISMATCH");
  if (!positiveInteger(invoice.paid_at)
    || invoice.paid_at
      < Math.floor(intent.commercialIntentCapturedAt!.getTime() / 1000)) {
    return mismatch("STALE_SETTLEMENT");
  }

  const invoiceCurrency = normalizedCurrency(invoice.currency);
  const paymentCurrency = normalizedCurrency(payment.currency);
  if (invoiceCurrency !== paymentCurrency || invoiceCurrency !== intent.authorizedCurrency) {
    return mismatch("CURRENCY_MISMATCH");
  }

  const providerPlan = input.providerPlan ?? null;
  if (!providerPlan) return mismatch("PROVIDER_PLAN_EVIDENCE_MISSING");
  if (providerPlan.entity !== "plan" || providerPlan.id !== intent.authorizedRazorpayPlanId) {
    return mismatch("PROVIDER_PLAN_MISMATCH");
  }
  if (providerPlan.item?.amount !== intent.authorizedUnitAmountSubunits
    || normalizedCurrency(providerPlan.item?.currency) !== intent.authorizedCurrency) {
    return mismatch("PLAN_AMOUNT_MISMATCH");
  }
  if (providerPlan.period.trim().toLowerCase() !== intent.authorizedPeriod
    || providerPlan.interval !== intent.authorizedInterval) {
    return mismatch("BILLING_CADENCE_MISMATCH");
  }

  let expectedAmountSubunits = intent.authorizedGrossAmountSubunits!;
  if (intent.authorizedRazorpayOfferId) {
    if (!positiveInteger(input.providerSubscription.paid_count)
      || !positiveInteger(intent.authorizedOfferValidThroughPaidCount)) {
      return mismatch("OFFER_CYCLE_EVIDENCE_MISSING");
    }
    if (input.providerSubscription.paid_count <= intent.authorizedOfferValidThroughPaidCount) {
      expectedAmountSubunits = intent.authorizedExpectedAmountSubunits!;
    }
  }
  if (invoice.amount !== expectedAmountSubunits) return mismatch("EXPECTED_AMOUNT_MISMATCH");

  if (!positiveInteger(invoice.billing_start)
    || !positiveInteger(invoice.billing_end)
    || !positiveInteger(input.providerSubscription.current_start)
    || !positiveInteger(input.providerSubscription.current_end)
    || invoice.billing_start !== input.providerSubscription.current_start
    || invoice.billing_end !== input.providerSubscription.current_end
    || invoice.billing_end <= invoice.billing_start) {
    return mismatch("BILLING_PERIOD_MISMATCH");
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (invoice.billing_start > nowSeconds || invoice.billing_end <= nowSeconds) {
    return mismatch("BILLING_PERIOD_MISMATCH");
  }
  if (input.providerSubscription.status.toLowerCase() !== "active") {
    return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  }

  return {
    kind: "EXACT_SETTLEMENT",
    expectedAmountSubunits,
    periodStart: new Date(invoice.billing_start * 1000),
    periodEnd: new Date(invoice.billing_end * 1000),
  };
}
