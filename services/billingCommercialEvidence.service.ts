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
  | "AMBIGUOUS_PROVIDER_EVIDENCE"
  | "INCOMPLETE_PROVIDER_EVIDENCE"
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

export type UnboundCommercialIntentWriteData = Omit<
  CommercialIntentWriteData,
  "authorizedSourceRazorpaySubscriptionId" | "authorizedRazorpaySubscriptionId"
> & {
  authorizedSourceRazorpaySubscriptionId: null;
  authorizedRazorpaySubscriptionId: null;
};

type BuildCommercialIntentWriteData = Omit<
  CommercialIntentWriteData,
  "authorizedSourceRazorpaySubscriptionId" | "authorizedRazorpaySubscriptionId"
> & {
  authorizedSourceRazorpaySubscriptionId: string | null;
  authorizedRazorpaySubscriptionId: string | null;
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

function providerRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function normalizedRequiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedProviderStatus(value: unknown) {
  return normalizedRequiredString(value)?.toLowerCase() ?? null;
}

function normalizedOptionalProviderId(value: unknown) {
  if (value == null) return { valid: true as const, value: null };
  const normalized = normalizedNullableId(value);
  return normalized
    ? { valid: true as const, value: normalized }
    : { valid: false as const, value: null };
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
    AMBIGUOUS_PROVIDER_EVIDENCE: "Multiple provider invoices could represent the current paid period",
    INCOMPLETE_PROVIDER_EVIDENCE: "The provider invoice collection is incomplete",
    MALFORMED_PROVIDER_EVIDENCE: "Razorpay returned malformed commercial evidence",
  };
  return messages[code];
}

function buildCommercialIntentSnapshotInternal(
  input: CommercialIntentSnapshotInput,
  allowUnboundSubscription: boolean
): BuildCommercialIntentWriteData {
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
  if ((!sourceProviderSubscriptionId && !allowUnboundSubscription)
    || !providerPlanId
    || currency.length !== 3
    || !period) {
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

export function buildCommercialIntentSnapshot(
  input: CommercialIntentSnapshotInput
): CommercialIntentWriteData {
  return buildCommercialIntentSnapshotInternal(input, false) as CommercialIntentWriteData;
}

export function buildUnboundCommercialIntentSnapshot(
  input: Omit<
    CommercialIntentSnapshotInput,
    "sourceRazorpaySubscriptionId" | "razorpaySubscriptionId"
  >
): UnboundCommercialIntentWriteData {
  return buildCommercialIntentSnapshotInternal({
    ...input,
    sourceRazorpaySubscriptionId: null,
    razorpaySubscriptionId: null,
  }, true) as UnboundCommercialIntentWriteData;
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

type ExactCommercialEvidenceInput = {
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
};

function validateExactCommercialEvidenceInternal(
  input: ExactCommercialEvidenceInput
): ExactCommercialEvidenceResult {
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

  const providerSubscription = providerRecord(input.providerSubscription);
  if (!providerSubscription
    || providerSubscription.entity !== "subscription") {
    return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  }
  const providerSubscriptionId = normalizedRequiredString(providerSubscription.id);
  const providerPlanId = normalizedRequiredString(providerSubscription.plan_id);
  const providerSubscriptionStatus = normalizedProviderStatus(providerSubscription.status);
  const providerQuantity = providerSubscription.quantity;
  const providerOffer = normalizedOptionalProviderId(providerSubscription.offer_id);
  if (!providerSubscriptionId
    || !providerPlanId
    || !providerSubscriptionStatus
    || !positiveInteger(providerQuantity)
    || !providerOffer.valid) {
    return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  }
  if (providerSubscriptionId !== intent.authorizedRazorpaySubscriptionId
    || input.localSubscription.razorpaySubscriptionId !== intent.authorizedRazorpaySubscriptionId) {
    return mismatch("SUBSCRIPTION_MISMATCH");
  }
  if (providerPlanId !== intent.authorizedRazorpayPlanId) {
    return mismatch("PROVIDER_PLAN_MISMATCH");
  }
  if (providerQuantity !== intent.authorizedQuantity) {
    return mismatch("QUANTITY_MISMATCH");
  }
  if (providerOffer.value !== normalizedNullableId(intent.authorizedRazorpayOfferId)) {
    return mismatch("OFFER_MISMATCH");
  }

  const rawPayment = input.payment ?? null;
  const payment = rawPayment ? providerRecord(rawPayment) : null;
  let paymentId: string | null = null;
  let paymentStatus: string | null = null;
  let paymentCurrency: string | null = null;
  let paymentSubscriptionId: string | null = null;
  let paymentInvoiceId: string | null = null;
  let paymentCaptured: boolean | undefined;
  let paymentAmount: number | null = null;
  if (rawPayment) {
    const optionalInvoiceId = payment
      ? normalizedOptionalProviderId(payment.invoice_id)
      : { valid: false as const, value: null };
    const optionalSubscriptionId = payment
      ? normalizedOptionalProviderId(payment.subscription_id)
      : { valid: false as const, value: null };
    paymentId = payment ? normalizedRequiredString(payment.id) : null;
    paymentStatus = payment ? normalizedProviderStatus(payment.status) : null;
    paymentCurrency = payment ? normalizedCurrency(payment.currency) : null;
    paymentAmount = payment && positiveInteger(payment.amount) ? payment.amount : null;
    paymentCaptured = payment?.captured as boolean | undefined;
    if (!payment
      || payment.entity !== "payment"
      || !paymentId
      || !paymentStatus
      || !paymentCurrency
      || paymentCurrency.length !== 3
      || paymentAmount == null
      || !optionalInvoiceId.valid
      || !optionalSubscriptionId.valid
      || (payment.captured !== undefined && typeof payment.captured !== "boolean")) {
      return mismatch("MALFORMED_PROVIDER_EVIDENCE");
    }
    paymentInvoiceId = optionalInvoiceId.value;
    paymentSubscriptionId = optionalSubscriptionId.value;
    if (input.expectedPaymentId && paymentId !== input.expectedPaymentId) {
      return mismatch("PAYMENT_ID_MISMATCH");
    }
    if (paymentSubscriptionId !== intent.authorizedRazorpaySubscriptionId) {
      return mismatch("PAYMENT_SUBSCRIPTION_MISMATCH");
    }
    if (paymentCurrency !== intent.authorizedCurrency) {
      return mismatch("CURRENCY_MISMATCH");
    }
  }

  const rawInvoice = input.invoice ?? null;
  const invoice = rawInvoice ? providerRecord(rawInvoice) : null;
  let invoiceId: string | null = null;
  let invoiceStatus: string | null = null;
  let invoiceCurrency: string | null = null;
  let invoiceSubscriptionId: string | null = null;
  let invoicePaymentId: string | null = null;
  if (!rawInvoice) {
    if (!rawPayment) return { kind: "PENDING" };
    if (paymentInvoiceId) {
      return mismatch("INVOICE_PAYMENT_MISMATCH");
    }
    if (paymentStatus === "authorized" && paymentCaptured !== false) {
      return mismatch("MALFORMED_PROVIDER_EVIDENCE");
    }
    if (paymentStatus === "captured" && paymentCaptured !== true) {
      return mismatch("MALFORMED_PROVIDER_EVIDENCE");
    }
    if (!["authorized", "captured"].includes(paymentStatus!)) {
      return mismatch("PAYMENT_NOT_AUTHORIZED");
    }
    if (!["created", "authenticated", "active"].includes(providerSubscriptionStatus)) {
      return { kind: "PENDING" };
    }
    return { kind: "AUTHORIZATION_ONLY" };
  }
  if (!rawPayment) return mismatch("INVOICE_PAYMENT_MISMATCH");
  const optionalInvoiceSubscriptionId = invoice
    ? normalizedOptionalProviderId(invoice.subscription_id)
    : { valid: false as const, value: null };
  const optionalInvoicePaymentId = invoice
    ? normalizedOptionalProviderId(invoice.payment_id)
    : { valid: false as const, value: null };
  invoiceId = invoice ? normalizedRequiredString(invoice.id) : null;
  invoiceStatus = invoice ? normalizedProviderStatus(invoice.status) : null;
  invoiceCurrency = invoice ? normalizedCurrency(invoice.currency) : null;
  if (!invoice
    || invoice.entity !== "invoice"
    || !invoiceId
    || !invoiceStatus
    || !invoiceCurrency
    || invoiceCurrency.length !== 3
    || !positiveInteger(invoice.amount)
    || !Number.isSafeInteger(invoice.amount_paid)
    || Number(invoice.amount_paid) < 0
    || !Number.isSafeInteger(invoice.amount_due)
    || Number(invoice.amount_due) < 0
    || !optionalInvoiceSubscriptionId.valid
    || !optionalInvoicePaymentId.valid) {
    return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  }
  invoiceSubscriptionId = optionalInvoiceSubscriptionId.value;
  invoicePaymentId = optionalInvoicePaymentId.value;
  if (invoiceSubscriptionId !== intent.authorizedRazorpaySubscriptionId) {
    return mismatch("INVOICE_SUBSCRIPTION_MISMATCH");
  }
  if (invoicePaymentId !== paymentId || paymentInvoiceId !== invoiceId) {
    return mismatch("INVOICE_PAYMENT_MISMATCH");
  }
  if (invoiceStatus !== "paid") return mismatch("INVOICE_NOT_PAID");
  if (paymentStatus !== "captured" || paymentCaptured === false) {
    return mismatch("PAYMENT_NOT_CAPTURED");
  }
  if (paymentCaptured !== true) return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  if (invoice.amount_due !== 0) return mismatch("INVOICE_AMOUNT_DUE");
  if (invoice.amount_paid !== invoice.amount) return mismatch("INVOICE_NOT_FULLY_PAID");
  if (paymentAmount !== invoice.amount) return mismatch("INVOICE_PAYMENT_AMOUNT_MISMATCH");
  if (!positiveInteger(invoice.paid_at)
    || invoice.paid_at
      < Math.floor(intent.commercialIntentCapturedAt!.getTime() / 1000)) {
    return mismatch("STALE_SETTLEMENT");
  }

  if (invoiceCurrency !== paymentCurrency || invoiceCurrency !== intent.authorizedCurrency) {
    return mismatch("CURRENCY_MISMATCH");
  }

  const rawProviderPlan = input.providerPlan ?? null;
  if (!rawProviderPlan) return mismatch("PROVIDER_PLAN_EVIDENCE_MISSING");
  const providerPlan = providerRecord(rawProviderPlan);
  const providerPlanEvidenceId = providerPlan
    ? normalizedRequiredString(providerPlan.id)
    : null;
  const providerPlanPeriod = providerPlan
    ? normalizedProviderStatus(providerPlan.period)
    : null;
  const providerPlanItem = providerRecord(providerPlan?.item);
  const providerPlanCurrency = normalizedCurrency(providerPlanItem?.currency);
  if (!providerPlan
    || providerPlan.entity !== "plan"
    || !providerPlanEvidenceId
    || !providerPlanPeriod
    || !positiveInteger(providerPlan.interval)
    || !providerPlanItem
    || !positiveInteger(providerPlanItem.amount)
    || providerPlanCurrency.length !== 3) {
    return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  }
  if (providerPlanEvidenceId !== intent.authorizedRazorpayPlanId) {
    return mismatch("PROVIDER_PLAN_MISMATCH");
  }
  if (providerPlanItem.amount !== intent.authorizedUnitAmountSubunits
    || providerPlanCurrency !== intent.authorizedCurrency) {
    return mismatch("PLAN_AMOUNT_MISMATCH");
  }
  if (providerPlanPeriod !== intent.authorizedPeriod
    || providerPlan.interval !== intent.authorizedInterval) {
    return mismatch("BILLING_CADENCE_MISMATCH");
  }

  let expectedAmountSubunits = intent.authorizedGrossAmountSubunits!;
  if (intent.authorizedRazorpayOfferId) {
    if (!positiveInteger(providerSubscription.paid_count)
      || !positiveInteger(intent.authorizedOfferValidThroughPaidCount)) {
      return mismatch("OFFER_CYCLE_EVIDENCE_MISSING");
    }
    if (providerSubscription.paid_count <= intent.authorizedOfferValidThroughPaidCount) {
      expectedAmountSubunits = intent.authorizedExpectedAmountSubunits!;
    }
  }
  if (invoice.amount !== expectedAmountSubunits) return mismatch("EXPECTED_AMOUNT_MISMATCH");

  if (!positiveInteger(invoice.billing_start)
    || !positiveInteger(invoice.billing_end)
    || !positiveInteger(providerSubscription.current_start)
    || !positiveInteger(providerSubscription.current_end)
    || invoice.billing_start !== providerSubscription.current_start
    || invoice.billing_end !== providerSubscription.current_end
    || invoice.billing_end <= invoice.billing_start) {
    return mismatch("BILLING_PERIOD_MISMATCH");
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (invoice.billing_start > nowSeconds || invoice.billing_end <= nowSeconds) {
    return mismatch("BILLING_PERIOD_MISMATCH");
  }
  if (providerSubscriptionStatus !== "active") {
    return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  }

  return {
    kind: "EXACT_SETTLEMENT",
    expectedAmountSubunits,
    periodStart: new Date(invoice.billing_start * 1000),
    periodEnd: new Date(invoice.billing_end * 1000),
  };
}

/** Treats every provider response as untrusted and never lets malformed evidence escape. */
export function validateExactCommercialEvidence(
  input: ExactCommercialEvidenceInput
): ExactCommercialEvidenceResult {
  try {
    return validateExactCommercialEvidenceInternal(input);
  } catch {
    return mismatch("MALFORMED_PROVIDER_EVIDENCE");
  }
}
