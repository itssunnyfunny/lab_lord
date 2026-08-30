import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  fromRazorpaySubunits,
  getRazorpayClient,
  resolveRazorpayMode,
  type RazorpayApiClient,
  type RazorpayInvoice,
  type RazorpayInvoices,
  type RazorpayPayment,
  type RazorpayPlan,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import {
  buildCommercialIntentSnapshot,
  commercialEvidenceMessage,
  readCommercialIntentSnapshot,
  validateExactCommercialEvidence,
  type CommercialEvidenceMismatchCode,
  type CommercialIntentWriteData,
} from "@/services/billingCommercialEvidence.service";
import { recordBillingMutationAudit } from "@/services/billingMutationAudit.service";
import {
  isSupportedProviderPaymentMethod,
  normalizeProviderPaymentMethod,
} from "@/services/billingPaymentMethod.service";
import {
  BILLING_PAID_EVIDENCE_INCLUDE,
  resolveTrustedPaidThrough,
  type BillingPaidEvidenceSubscription,
} from "@/services/billingPaidEvidence.service";
import type {
  BillingOffer,
  Organization,
  OrganizationBillingChange,
  OrganizationSubscription,
  OrganizationSubscriptionInvoice,
  Prisma,
  RazorpayMode,
} from "@/app/generated/prisma/client";

const TRANSITION_VERSION = 1 as const;
const TRANSITION_KEY_PREFIX = "legacy-paid-entitlement-transition:v1";
const REVIEW_KEY_PREFIX = "legacy-paid-entitlement-review:v1";

const LEGACY_PAID_ENTITLEMENT_CANDIDATE_SELECT = {
  id: true,
  billingModelVersion: true,
  billingMutationSequence: true,
  billingMutationLeaseToken: true,
  billingMutationLeaseUntil: true,
  subscription: {
    include: {
      billingOffer: true,
      replacesSubscription: {
        select: {
          id: true,
          organizationId: true,
          providerMode: true,
          razorpaySubscriptionId: true,
        },
      },
      confirmedCommercialIntentChange: true,
      invoices: {
        where: { commercialEvidenceVersion: 1 },
        orderBy: { periodEnd: "desc" as const },
        take: 1,
        include: { commercialIntentChange: true },
      },
    },
  },
} satisfies Prisma.OrganizationSelect;

export type LegacyPaidEntitlementManualReviewCode =
  | CommercialEvidenceMismatchCode
  | "ORGANIZATION_NOT_FOUND"
  | "ORGANIZATION_NOT_LEGACY"
  | "SUBSCRIPTION_NOT_FOUND"
  | "LOCAL_COMMERCIAL_SNAPSHOT_INVALID"
  | "EXISTING_EVIDENCE_INCOMPLETE"
  | "BILLING_MUTATION_IN_FLIGHT"
  | "INCOMPLETE_INVOICE_COLLECTION"
  | "CURRENT_PAID_INVOICE_MISSING"
  | "AMBIGUOUS_CURRENT_PAID_INVOICES"
  | "PROVIDER_READ_FAILED"
  | "LOCAL_SNAPSHOT_CHANGED"
  | "TRANSITION_STATE_CONFLICT";

export type LegacyPaidEntitlementDisposition =
  | "EXACT_SETTLEMENT"
  | "MANUAL_REVIEW_REQUIRED"
  | "ALREADY_EVIDENCE_BACKED"
  | "NOT_LEGACY"
  | "NO_SUBSCRIPTION"
  | "NOT_FOUND";

type SubscriptionWithEvidence = OrganizationSubscription & {
  billingOffer: BillingOffer | null;
  replacesSubscription: {
    id: string;
    organizationId: string;
    providerMode: RazorpayMode;
    razorpaySubscriptionId: string;
  } | null;
  confirmedCommercialIntentChange: OrganizationBillingChange | null;
  invoices: Array<OrganizationSubscriptionInvoice & {
    commercialIntentChange: OrganizationBillingChange | null;
  }>;
};

export type LegacyPaidEntitlementCandidate = Pick<
  Organization,
  | "id"
  | "billingModelVersion"
  | "billingMutationSequence"
  | "billingMutationLeaseToken"
  | "billingMutationLeaseUntil"
> & {
  subscription: SubscriptionWithEvidence | null;
};

export type LegacyPaidEntitlementProviderReader = Pick<
  RazorpayApiClient,
  "fetchSubscription" | "fetchSubscriptionInvoices" | "fetchPayment"
> & {
  fetchPlan?: (planId: string) => Promise<RazorpayPlan>;
};

type VerifiedSettlement = {
  providerSubscription: RazorpaySubscription;
  invoices: RazorpayInvoices;
  invoice: RazorpayInvoice;
  payment: RazorpayPayment;
  providerPlan: RazorpayPlan;
  periodStart: Date;
  periodEnd: Date;
};

export type LegacyPaidEntitlementInspection = {
  organizationId: string;
  organizationSubscriptionId: string | null;
  razorpaySubscriptionId: string | null;
  disposition: LegacyPaidEntitlementDisposition;
  manualReviewCode: LegacyPaidEntitlementManualReviewCode | null;
  localSnapshotHash: string;
  providerEvidenceHash: string | null;
  proposalHash: string;
  proposedPaidThrough: Date | null;
  providerInvoiceId: string | null;
  providerPaymentId: string | null;
  commercialIntent: CommercialIntentWriteData | null;
  verifiedSettlement: VerifiedSettlement | null;
};

export type LegacyPaidEntitlementResultRow = Omit<
  LegacyPaidEntitlementInspection,
  "commercialIntent" | "verifiedSettlement"
> & {
  changeId: string | null;
  applied: boolean;
  persistedManualReview: boolean;
};

function hash(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dateValue(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function normalizedId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function providerDate(value: number | null | undefined) {
  return positiveInteger(value) ? new Date(value * 1000) : null;
}

function candidateSnapshotValue(candidate: LegacyPaidEntitlementCandidate) {
  const subscription = candidate.subscription;
  return {
    version: TRANSITION_VERSION,
    organizationId: candidate.id,
    billingModelVersion: candidate.billingModelVersion,
    billingMutationSequence: candidate.billingMutationSequence,
    billingMutationLeaseToken: candidate.billingMutationLeaseToken,
    billingMutationLeaseUntil: dateValue(candidate.billingMutationLeaseUntil),
    subscription: subscription
      ? {
          id: subscription.id,
          organizationId: subscription.organizationId,
          currentOrganizationId: subscription.currentOrganizationId,
          providerMode: subscription.providerMode,
          plan: subscription.plan,
          status: subscription.status,
          amount: subscription.amount,
          amountSubunits: subscription.amountSubunits,
          currency: subscription.currency,
          period: subscription.period,
          interval: subscription.interval,
          quantity: subscription.quantity,
          razorpayPlanId: subscription.razorpayPlanId,
          razorpaySubscriptionId: subscription.razorpaySubscriptionId,
          billingOfferId: subscription.billingOfferId,
          authPaymentId: subscription.authPaymentId,
          providerPaymentMethod: subscription.providerPaymentMethod,
          paidThrough: dateValue(subscription.paidThrough),
          lastConfirmedInvoiceId: subscription.lastConfirmedInvoiceId,
          lastConfirmedPaymentId: subscription.lastConfirmedPaymentId,
          confirmedCommercialIntentChangeId:
            subscription.confirmedCommercialIntentChangeId,
          createdAt: dateValue(subscription.createdAt),
          updatedAt: dateValue(subscription.updatedAt),
          offer: subscription.billingOffer
            ? {
                id: subscription.billingOffer.id,
                providerMode: subscription.billingOffer.providerMode,
                plan: subscription.billingOffer.plan,
                razorpayOfferId: subscription.billingOffer.razorpayOfferId,
                discountType: subscription.billingOffer.discountType,
                discountValue: subscription.billingOffer.discountValue,
                durationType: subscription.billingOffer.durationType,
                durationCycles: subscription.billingOffer.durationCycles,
                updatedAt: dateValue(subscription.billingOffer.updatedAt),
              }
            : null,
        }
      : null,
  };
}

export function legacyPaidEntitlementLocalSnapshotHash(
  candidate: LegacyPaidEntitlementCandidate
) {
  return hash(candidateSnapshotValue(candidate));
}

export function legacyPaidEntitlementIdempotencyKey(input: {
  organizationId: string;
  organizationSubscriptionId: string;
}) {
  return [
    TRANSITION_KEY_PREFIX,
    input.organizationId,
    input.organizationSubscriptionId,
  ].join(":");
}

function reviewIdempotencyKey(input: {
  organizationId: string;
  organizationSubscriptionId: string;
  code: LegacyPaidEntitlementManualReviewCode;
  stateHash: string;
}) {
  return [
    REVIEW_KEY_PREFIX,
    input.organizationId,
    input.organizationSubscriptionId,
    input.code,
    input.stateHash,
  ].join(":");
}

function proposalHash(input: {
  organizationId: string;
  subscriptionId: string | null;
  localSnapshotHash: string;
  disposition: LegacyPaidEntitlementDisposition;
  manualReviewCode: LegacyPaidEntitlementManualReviewCode | null;
  providerEvidenceHash?: string | null;
  providerInvoiceId?: string | null;
  providerPaymentId?: string | null;
  proposedPaidThrough?: Date | null;
}) {
  return hash({
    version: TRANSITION_VERSION,
    organizationId: input.organizationId,
    organizationSubscriptionId: input.subscriptionId,
    localSnapshotHash: input.localSnapshotHash,
    disposition: input.disposition,
    manualReviewCode: input.manualReviewCode,
    providerEvidenceHash: input.providerEvidenceHash ?? null,
    providerInvoiceId: input.providerInvoiceId ?? null,
    providerPaymentId: input.providerPaymentId ?? null,
    proposedPaidThrough: dateValue(input.proposedPaidThrough),
  });
}

function verifiedSettlementHash(settlement: VerifiedSettlement) {
  const subscription = settlement.providerSubscription;
  const invoice = settlement.invoice;
  const payment = settlement.payment;
  const plan = settlement.providerPlan;
  return hash({
    version: TRANSITION_VERSION,
    subscription: {
      id: subscription.id,
      entity: subscription.entity,
      planId: subscription.plan_id,
      status: subscription.status,
      quantity: subscription.quantity,
      paidCount: subscription.paid_count,
      offerId: subscription.offer_id ?? null,
      currentStart: subscription.current_start,
      currentEnd: subscription.current_end,
    },
    invoice: {
      id: invoice.id,
      entity: invoice.entity,
      subscriptionId: invoice.subscription_id ?? null,
      paymentId: invoice.payment_id ?? null,
      status: invoice.status,
      amount: invoice.amount,
      amountPaid: invoice.amount_paid,
      amountDue: invoice.amount_due,
      currency: invoice.currency,
      billingStart: invoice.billing_start,
      billingEnd: invoice.billing_end,
      paidAt: invoice.paid_at,
    },
    payment: {
      id: payment.id,
      entity: payment.entity,
      subscriptionId: payment.subscription_id ?? null,
      invoiceId: payment.invoice_id ?? null,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      captured: payment.captured,
      method: payment.method ?? null,
    },
    plan: {
      id: plan.id,
      entity: plan.entity,
      period: plan.period,
      interval: plan.interval,
      amount: plan.item?.amount,
      currency: plan.item?.currency,
    },
    periodStart: settlement.periodStart.toISOString(),
    periodEnd: settlement.periodEnd.toISOString(),
  });
}

function inspection(input: Omit<
  LegacyPaidEntitlementInspection,
  "proposalHash" | "providerEvidenceHash"
>) {
  const providerEvidenceHash = input.verifiedSettlement
    ? verifiedSettlementHash(input.verifiedSettlement)
    : null;
  return {
    ...input,
    providerEvidenceHash,
    proposalHash: proposalHash({
      organizationId: input.organizationId,
      subscriptionId: input.organizationSubscriptionId,
      localSnapshotHash: input.localSnapshotHash,
      disposition: input.disposition,
      manualReviewCode: input.manualReviewCode,
      providerEvidenceHash,
      providerInvoiceId: input.providerInvoiceId,
      providerPaymentId: input.providerPaymentId,
      proposedPaidThrough: input.proposedPaidThrough,
    }),
  } satisfies LegacyPaidEntitlementInspection;
}

function manualInspection(input: {
  candidate: LegacyPaidEntitlementCandidate;
  localSnapshotHash: string;
  code: LegacyPaidEntitlementManualReviewCode;
  commercialIntent?: CommercialIntentWriteData | null;
}) {
  return inspection({
    organizationId: input.candidate.id,
    organizationSubscriptionId: input.candidate.subscription?.id ?? null,
    razorpaySubscriptionId:
      input.candidate.subscription?.razorpaySubscriptionId ?? null,
    disposition: "MANUAL_REVIEW_REQUIRED",
    manualReviewCode: input.code,
    localSnapshotHash: input.localSnapshotHash,
    proposedPaidThrough: null,
    providerInvoiceId: null,
    providerPaymentId: null,
    commercialIntent: input.commercialIntent ?? null,
    verifiedSettlement: null,
  });
}

function buildLegacyCommercialIntent(
  candidate: LegacyPaidEntitlementCandidate,
  providerMode: RazorpayMode
) {
  const subscription = candidate.subscription;
  if (!subscription
    || subscription.organizationId !== candidate.id
    || subscription.currentOrganizationId !== candidate.id
    || subscription.providerMode !== providerMode) {
    throw new Error("Local subscription identity does not match the requested transition");
  }
  const offer = subscription.billingOffer;
  if ((subscription.billingOfferId == null) !== (offer == null)
    || (offer && (
      offer.id !== subscription.billingOfferId
      || offer.providerMode !== providerMode
      || offer.plan !== subscription.plan
    ))) {
    throw new Error("Local offer evidence is incomplete or inconsistent");
  }
  return buildCommercialIntentSnapshot({
    providerMode,
    sourceRazorpaySubscriptionId: subscription.razorpaySubscriptionId,
    razorpaySubscriptionId: subscription.razorpaySubscriptionId,
    sourceRazorpayPlanId: subscription.razorpayPlanId,
    razorpayPlanId: subscription.razorpayPlanId,
    plan: subscription.plan,
    quantity: subscription.quantity,
    unitAmountSubunits: subscription.amountSubunits,
    currency: subscription.currency,
    period: subscription.period,
    interval: subscription.interval,
    capturedAt: subscription.createdAt,
    offer: offer
      ? {
          razorpayOfferId: offer.razorpayOfferId,
          discountType: offer.discountType,
          discountValue: offer.discountValue,
          durationType: offer.durationType,
          durationCycles: offer.durationCycles,
        }
      : null,
  });
}

function completeStoredEvidence(subscription: SubscriptionWithEvidence, now: Date) {
  return resolveTrustedPaidThrough(
    subscription as BillingPaidEvidenceSubscription,
    now
  ) != null;
}

export function hasCompleteRazorpayInvoiceCollection(
  value: unknown
): value is RazorpayInvoices {
  if (!value || typeof value !== "object") return false;
  const collection = value as Record<string, unknown>;
  if (collection.entity !== "collection"
    || !Number.isSafeInteger(collection.count)
    || Number(collection.count) < 0
    || !Array.isArray(collection.items)
    || collection.count !== collection.items.length) return false;
  return collection.items.every(item => {
    if (!item || typeof item !== "object") return false;
    const invoice = item as Record<string, unknown>;
    const baseShape = invoice.entity === "invoice"
      && normalizedId(invoice.id) != null
      && normalizedId(invoice.status) != null
      && positiveInteger(invoice.amount)
      && Number.isSafeInteger(invoice.amount_paid)
      && Number(invoice.amount_paid) >= 0
      && Number.isSafeInteger(invoice.amount_due)
      && Number(invoice.amount_due) >= 0
      && typeof invoice.currency === "string"
      && invoice.currency.trim().length === 3;
    if (!baseShape || String(invoice.status).trim().toLowerCase() !== "paid") {
      return baseShape;
    }
    return normalizedId(invoice.subscription_id) != null
      && normalizedId(invoice.payment_id) != null
      && positiveInteger(invoice.billing_start)
      && positiveInteger(invoice.billing_end)
      && Number(invoice.billing_end) > Number(invoice.billing_start);
  });
}

export function currentPaidInvoiceCandidates(
  subscription: RazorpaySubscription,
  invoices: readonly RazorpayInvoice[]
) {
  return invoices.filter(invoice =>
    invoice.status.trim().toLowerCase() === "paid"
    && normalizedId(invoice.payment_id) != null
    && invoice.subscription_id === subscription.id
    && positiveInteger(invoice.billing_start)
    && positiveInteger(invoice.billing_end)
    && invoice.billing_start === subscription.current_start
    && invoice.billing_end === subscription.current_end
  );
}

/**
 * Provider reads happen here, before any transaction. The returned proposal
 * contains only exact evidence or a fail-closed manual-review disposition.
 */
export async function inspectLegacyPaidEntitlementCandidate(input: {
  candidate: LegacyPaidEntitlementCandidate;
  providerMode: RazorpayMode;
  provider: LegacyPaidEntitlementProviderReader;
  now?: Date;
}): Promise<LegacyPaidEntitlementInspection> {
  const now = input.now ?? new Date();
  const candidate = input.candidate;
  const localSnapshotHash = legacyPaidEntitlementLocalSnapshotHash(candidate);
  if (candidate.billingModelVersion !== "LEGACY") {
    return inspection({
      organizationId: candidate.id,
      organizationSubscriptionId: candidate.subscription?.id ?? null,
      razorpaySubscriptionId: candidate.subscription?.razorpaySubscriptionId ?? null,
      disposition: "NOT_LEGACY",
      manualReviewCode: "ORGANIZATION_NOT_LEGACY",
      localSnapshotHash,
      proposedPaidThrough: null,
      providerInvoiceId: null,
      providerPaymentId: null,
      commercialIntent: null,
      verifiedSettlement: null,
    });
  }
  const subscription = candidate.subscription;
  if (!subscription) {
    return inspection({
      organizationId: candidate.id,
      organizationSubscriptionId: null,
      razorpaySubscriptionId: null,
      disposition: "NO_SUBSCRIPTION",
      manualReviewCode: "SUBSCRIPTION_NOT_FOUND",
      localSnapshotHash,
      proposedPaidThrough: null,
      providerInvoiceId: null,
      providerPaymentId: null,
      commercialIntent: null,
      verifiedSettlement: null,
    });
  }
  if (subscription.providerMode !== input.providerMode) {
    return manualInspection({
      candidate,
      localSnapshotHash,
      code: "PROVIDER_MODE_MISMATCH",
    });
  }
  if (candidate.billingMutationLeaseToken) {
    return manualInspection({
      candidate,
      localSnapshotHash,
      code: "BILLING_MUTATION_IN_FLIGHT",
    });
  }
  let commercialIntent: CommercialIntentWriteData;
  try {
    commercialIntent = buildLegacyCommercialIntent(candidate, input.providerMode);
  } catch {
    return manualInspection({
      candidate,
      localSnapshotHash,
      code: "LOCAL_COMMERCIAL_SNAPSHOT_INVALID",
    });
  }
  if (completeStoredEvidence(subscription, now)) {
    return inspection({
      organizationId: candidate.id,
      organizationSubscriptionId: subscription.id,
      razorpaySubscriptionId: subscription.razorpaySubscriptionId,
      disposition: "ALREADY_EVIDENCE_BACKED",
      manualReviewCode: null,
      localSnapshotHash,
      proposedPaidThrough: subscription.paidThrough,
      providerInvoiceId: subscription.lastConfirmedInvoiceId,
      providerPaymentId: subscription.lastConfirmedPaymentId,
      commercialIntent,
      verifiedSettlement: null,
    });
  }
  if (subscription.confirmedCommercialIntentChangeId
    || subscription.lastConfirmedInvoiceId
    || subscription.lastConfirmedPaymentId) {
    return manualInspection({
      candidate,
      localSnapshotHash,
      code: "EXISTING_EVIDENCE_INCOMPLETE",
      commercialIntent,
    });
  }

  try {
    const [providerSubscription, invoices] = await Promise.all([
      input.provider.fetchSubscription(subscription.razorpaySubscriptionId),
      input.provider.fetchSubscriptionInvoices(subscription.razorpaySubscriptionId),
    ]);
    if (!hasCompleteRazorpayInvoiceCollection(invoices)) {
      return manualInspection({
        candidate,
        localSnapshotHash,
        code: "INCOMPLETE_INVOICE_COLLECTION",
        commercialIntent,
      });
    }
    if (invoices.items.some(invoice =>
      invoice.status.trim().toLowerCase() === "paid"
      && invoice.subscription_id !== providerSubscription.id
    )) {
      return manualInspection({
        candidate,
        localSnapshotHash,
        code: "MALFORMED_PROVIDER_EVIDENCE",
        commercialIntent,
      });
    }
    const paidInvoices = currentPaidInvoiceCandidates(providerSubscription, invoices.items);
    if (paidInvoices.length === 0) {
      return manualInspection({
        candidate,
        localSnapshotHash,
        code: "CURRENT_PAID_INVOICE_MISSING",
        commercialIntent,
      });
    }
    if (paidInvoices.length !== 1) {
      return manualInspection({
        candidate,
        localSnapshotHash,
        code: "AMBIGUOUS_CURRENT_PAID_INVOICES",
        commercialIntent,
      });
    }
    const invoice = paidInvoices[0]!;
    if (!invoice.payment_id || !input.provider.fetchPlan) {
      return manualInspection({
        candidate,
        localSnapshotHash,
        code: "MALFORMED_PROVIDER_EVIDENCE",
        commercialIntent,
      });
    }
    const [payment, providerPlan] = await Promise.all([
      input.provider.fetchPayment(invoice.payment_id),
      input.provider.fetchPlan(providerSubscription.plan_id),
    ]);
    const syntheticIntent = {
      id: legacyPaidEntitlementIdempotencyKey({
        organizationId: candidate.id,
        organizationSubscriptionId: subscription.id,
      }),
      organizationId: candidate.id,
      toPlan: subscription.plan,
      toQuantity: subscription.quantity,
      ...commercialIntent,
    };
    const exact = validateExactCommercialEvidence({
      intent: syntheticIntent,
      organizationId: candidate.id,
      providerMode: input.providerMode,
      localSubscription: subscription,
      providerSubscription,
      payment,
      expectedPaymentId: invoice.payment_id,
      invoice,
      providerPlan,
      now,
    });
    if (exact.kind !== "EXACT_SETTLEMENT") {
      return manualInspection({
        candidate,
        localSnapshotHash,
        code: exact.kind === "MISMATCH"
          ? exact.code
          : "CURRENT_PAID_INVOICE_MISSING",
        commercialIntent,
      });
    }
    const paymentMethod = normalizeProviderPaymentMethod(payment.method);
    if (!isSupportedProviderPaymentMethod(paymentMethod)) {
      return manualInspection({
        candidate,
        localSnapshotHash,
        code: "MALFORMED_PROVIDER_EVIDENCE",
        commercialIntent,
      });
    }
    return inspection({
      organizationId: candidate.id,
      organizationSubscriptionId: subscription.id,
      razorpaySubscriptionId: subscription.razorpaySubscriptionId,
      disposition: "EXACT_SETTLEMENT",
      manualReviewCode: null,
      localSnapshotHash,
      proposedPaidThrough: exact.periodEnd,
      providerInvoiceId: invoice.id,
      providerPaymentId: payment.id,
      commercialIntent,
      verifiedSettlement: {
        providerSubscription,
        invoices,
        invoice,
        payment,
        providerPlan,
        periodStart: exact.periodStart,
        periodEnd: exact.periodEnd,
      },
    });
  } catch {
    return manualInspection({
      candidate,
      localSnapshotHash,
      code: "PROVIDER_READ_FAILED",
      commercialIntent,
    });
  }
}

export function legacyPaidEntitlementBatchProposalHash(
  inspections: readonly Pick<LegacyPaidEntitlementInspection, "organizationId" | "proposalHash">[]
) {
  return hash({
    version: TRANSITION_VERSION,
    proposals: [...inspections]
      .sort((left, right) => left.organizationId.localeCompare(right.organizationId))
      .map(row => ({ organizationId: row.organizationId, proposalHash: row.proposalHash })),
  });
}

function manualReviewMessage(code: LegacyPaidEntitlementManualReviewCode) {
  if (code in ({
    COMMERCIAL_INTENT_MISSING: true,
    COMMERCIAL_INTENT_INVALID: true,
    ORGANIZATION_MISMATCH: true,
    PROVIDER_MODE_MISMATCH: true,
    SUBSCRIPTION_MISMATCH: true,
    AUTHORIZED_PLAN_MISMATCH: true,
    PROVIDER_PLAN_MISMATCH: true,
    PROVIDER_PLAN_EVIDENCE_MISSING: true,
    PLAN_AMOUNT_MISMATCH: true,
    BILLING_CADENCE_MISMATCH: true,
    QUANTITY_MISMATCH: true,
    OFFER_MISMATCH: true,
    PAYMENT_ID_MISMATCH: true,
    PAYMENT_SUBSCRIPTION_MISMATCH: true,
    PAYMENT_NOT_AUTHORIZED: true,
    INVOICE_SUBSCRIPTION_MISMATCH: true,
    INVOICE_PAYMENT_MISMATCH: true,
    INVOICE_NOT_PAID: true,
    PAYMENT_NOT_CAPTURED: true,
    INVOICE_AMOUNT_DUE: true,
    INVOICE_NOT_FULLY_PAID: true,
    INVOICE_PAYMENT_AMOUNT_MISMATCH: true,
    EXPECTED_AMOUNT_MISMATCH: true,
    CURRENCY_MISMATCH: true,
    OFFER_CYCLE_EVIDENCE_MISSING: true,
    STALE_SETTLEMENT: true,
    COMMERCIAL_FINALIZATION_FAILED: true,
    BILLING_PERIOD_MISMATCH: true,
    AMBIGUOUS_PROVIDER_EVIDENCE: true,
    INCOMPLETE_PROVIDER_EVIDENCE: true,
    MALFORMED_PROVIDER_EVIDENCE: true,
  } as Record<string, true>)) {
    return commercialEvidenceMessage(code as CommercialEvidenceMismatchCode);
  }
  const messages: Record<Exclude<
    LegacyPaidEntitlementManualReviewCode,
    CommercialEvidenceMismatchCode
  >, string> = {
    ORGANIZATION_NOT_FOUND: "The requested organization was not found",
    ORGANIZATION_NOT_LEGACY: "The organization is not on the legacy billing model",
    SUBSCRIPTION_NOT_FOUND: "The organization has no current subscription",
    LOCAL_COMMERCIAL_SNAPSHOT_INVALID: "The stored legacy commercial snapshot is incomplete",
    EXISTING_EVIDENCE_INCOMPLETE: "Existing commercial evidence is incomplete or inconsistent",
    BILLING_MUTATION_IN_FLIGHT: "A billing mutation lease is currently owned",
    INCOMPLETE_INVOICE_COLLECTION: "The provider invoice collection is incomplete or malformed",
    CURRENT_PAID_INVOICE_MISSING: "No exact current paid invoice was found",
    AMBIGUOUS_CURRENT_PAID_INVOICES: "Multiple current paid invoices require manual review",
    PROVIDER_READ_FAILED: "Provider evidence could not be read",
    LOCAL_SNAPSHOT_CHANGED: "Local billing state changed after inspection",
    TRANSITION_STATE_CONFLICT: "An incompatible transition record already exists",
  };
  return messages[code as keyof typeof messages];
}

async function loadLockedCandidate(
  tx: Prisma.TransactionClient,
  organizationId: string
): Promise<LegacyPaidEntitlementCandidate | null> {
  return tx.organization.findUnique({
    where: { id: organizationId },
    select: LEGACY_PAID_ENTITLEMENT_CANDIDATE_SELECT,
  });
}

async function nextBillingSequence(tx: Prisma.TransactionClient, candidate: LegacyPaidEntitlementCandidate) {
  const existing = await tx.organizationBillingChange.aggregate({
    where: { organizationId: candidate.id },
    _max: { sequence: true },
  });
  const sequence = Math.max(
    candidate.billingMutationSequence,
    existing._max.sequence ?? 0
  ) + 1;
  await tx.organization.update({
    where: { id: candidate.id },
    data: { billingMutationSequence: sequence },
  });
  return sequence;
}

function sameCommercialIntent(
  change: OrganizationBillingChange,
  intent: CommercialIntentWriteData
) {
  try {
    const stored = readCommercialIntentSnapshot(change, {
      requireBoundSubscription: true,
    });
    return hash(stored) === hash(intent);
  } catch {
    return false;
  }
}

async function ensureTransitionRecord(input: {
  tx: Prisma.TransactionClient;
  candidate: LegacyPaidEntitlementCandidate;
  intent: CommercialIntentWriteData;
  now: Date;
}) {
  const subscription = input.candidate.subscription!;
  const idempotencyKey = legacyPaidEntitlementIdempotencyKey({
    organizationId: input.candidate.id,
    organizationSubscriptionId: subscription.id,
  });
  const existing = await input.tx.organizationBillingChange.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    if (existing.organizationId !== input.candidate.id
      || existing.organizationSubscriptionId !== subscription.id
      || existing.type !== "LEGACY_TRANSITION"
      || ["UNDONE", "SUPERSEDED"].includes(existing.status)
      || !sameCommercialIntent(existing, input.intent)) {
      throw new Error("TRANSITION_STATE_CONFLICT");
    }
    return existing;
  }
  const sequence = await nextBillingSequence(input.tx, input.candidate);
  return input.tx.organizationBillingChange.create({
    data: {
      organizationId: input.candidate.id,
      organizationSubscriptionId: subscription.id,
      sequence,
      idempotencyKey,
      type: "LEGACY_TRANSITION",
      status: "QUEUED",
      operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
      fromPlan: subscription.plan,
      toPlan: subscription.plan,
      fromQuantity: subscription.quantity,
      toQuantity: subscription.quantity,
      ...input.intent,
      effectiveAt: input.now,
    },
  });
}

async function ensureManualReviewRecord(input: {
  tx: Prisma.TransactionClient;
  candidate: LegacyPaidEntitlementCandidate;
  intent: CommercialIntentWriteData | null;
  code: LegacyPaidEntitlementManualReviewCode;
  now: Date;
}) {
  const subscription = input.candidate.subscription!;
  const idempotencyKey = reviewIdempotencyKey({
    organizationId: input.candidate.id,
    organizationSubscriptionId: subscription.id,
    code: input.code,
    // Creating or retaining a review changes the organization sequence but not
    // this subscription/offer snapshot, so retries reuse the same review. A
    // later exact resolution changes the snapshot and can be quarantined again.
    stateHash: hash(candidateSnapshotValue(input.candidate).subscription),
  });
  const expectedType = input.intent ? "LEGACY_TRANSITION" : "COMMERCIAL_RECONCILIATION";
  const existing = await input.tx.organizationBillingChange.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    if (existing.organizationId !== input.candidate.id
      || existing.organizationSubscriptionId !== subscription.id
      || existing.type !== expectedType
      || ["UNDONE", "SUPERSEDED", "APPLIED"].includes(existing.status)
      || (input.intent && !sameCommercialIntent(existing, input.intent))) {
      throw new Error("TRANSITION_STATE_CONFLICT");
    }
    return existing;
  }
  const sequence = await nextBillingSequence(input.tx, input.candidate);
  return input.tx.organizationBillingChange.create({
    data: {
      organizationId: input.candidate.id,
      organizationSubscriptionId: subscription.id,
      sequence,
      idempotencyKey,
      type: expectedType,
      status: "QUEUED",
      operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
      fromPlan: subscription.plan,
      toPlan: subscription.plan,
      fromQuantity: subscription.quantity,
      toQuantity: subscription.quantity,
      ...(input.intent ?? {}),
      effectiveAt: input.now,
    },
  });
}

function existingInvoiceConflicts(input: {
  existing: OrganizationSubscriptionInvoice;
  organizationId: string;
  subscriptionId: string;
  intentId: string;
  settlement: VerifiedSettlement;
  providerMode: RazorpayMode;
}) {
  const { existing, settlement } = input;
  if (existing.organizationId !== input.organizationId
    || existing.organizationSubscriptionId !== input.subscriptionId) return true;
  if (existing.commercialEvidenceVersion == null) return false;
  return existing.commercialEvidenceVersion !== 1
    || existing.commercialIntentChangeId !== input.intentId
    || existing.providerMode !== input.providerMode
    || existing.razorpaySubscriptionId !== settlement.providerSubscription.id
    || existing.razorpayPlanId !== settlement.providerSubscription.plan_id
    || existing.providerQuantity !== settlement.providerSubscription.quantity
    || existing.razorpayOfferId !== (settlement.providerSubscription.offer_id ?? null)
    || existing.razorpayPaymentId !== settlement.payment.id
    || existing.paymentAmountSubunits !== settlement.payment.amount
    || existing.paymentCurrency !== settlement.payment.currency.toUpperCase()
    || existing.paymentStatus?.toLowerCase() !== "captured"
    || existing.paymentCaptured !== true
    || existing.periodStart?.getTime() !== settlement.periodStart.getTime()
    || existing.periodEnd?.getTime() !== settlement.periodEnd.getTime();
}

class StaleLegacyPaidEntitlementProposalError extends Error {}

async function applyExactSettlement(input: {
  assessment: LegacyPaidEntitlementInspection;
  providerMode: RazorpayMode;
  now: Date;
}) {
  const intent = input.assessment.commercialIntent;
  const settlement = input.assessment.verifiedSettlement;
  if (!intent || !settlement || !input.assessment.organizationSubscriptionId) {
    throw new Error("COMMERCIAL_FINALIZATION_FAILED");
  }
  return prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization"
      WHERE "id" = ${input.assessment.organizationId}
      FOR UPDATE
    `;
    const candidate = await loadLockedCandidate(tx, input.assessment.organizationId);
    if (!candidate
      || candidate.billingModelVersion !== "LEGACY"
      || candidate.billingMutationLeaseToken
      || legacyPaidEntitlementLocalSnapshotHash(candidate)
        !== input.assessment.localSnapshotHash) {
      throw new StaleLegacyPaidEntitlementProposalError();
    }
    const subscription = candidate.subscription;
    if (!subscription || subscription.id !== input.assessment.organizationSubscriptionId) {
      throw new StaleLegacyPaidEntitlementProposalError();
    }
    const change = await ensureTransitionRecord({
      tx,
      candidate,
      intent,
      now: input.now,
    });
    if (change.status === "APPLIED"
      && subscription.confirmedCommercialIntentChangeId === change.id
      && subscription.lastConfirmedInvoiceId === settlement.invoice.id
      && subscription.lastConfirmedPaymentId === settlement.payment.id
      && subscription.paidThrough
      && subscription.paidThrough >= settlement.periodEnd) {
      return { changeId: change.id, applied: false, alreadyApplied: true };
    }
    const lockedEvidence = validateExactCommercialEvidence({
      intent: change,
      organizationId: candidate.id,
      providerMode: input.providerMode,
      localSubscription: subscription,
      providerSubscription: settlement.providerSubscription,
      payment: settlement.payment,
      expectedPaymentId: settlement.payment.id,
      invoice: settlement.invoice,
      providerPlan: settlement.providerPlan,
      now: input.now,
    });
    if (lockedEvidence.kind !== "EXACT_SETTLEMENT") {
      throw new Error(
        lockedEvidence.kind === "MISMATCH"
          ? lockedEvidence.code
          : "COMMERCIAL_FINALIZATION_FAILED"
      );
    }
    const [existingInvoice, existingPaymentInvoice] = await Promise.all([
      tx.organizationSubscriptionInvoice.findUnique({
        where: { razorpayInvoiceId: settlement.invoice.id },
      }),
      tx.organizationSubscriptionInvoice.findUnique({
        where: { razorpayPaymentId: settlement.payment.id },
      }),
    ]);
    if ((existingInvoice && existingInvoiceConflicts({
      existing: existingInvoice,
      organizationId: candidate.id,
      subscriptionId: subscription.id,
      intentId: change.id,
      settlement,
      providerMode: input.providerMode,
    })) || (existingPaymentInvoice
      && existingPaymentInvoice.razorpayInvoiceId !== settlement.invoice.id)) {
      throw new Error("MALFORMED_PROVIDER_EVIDENCE");
    }
    const paymentMethod = normalizeProviderPaymentMethod(settlement.payment.method);
    if (!isSupportedProviderPaymentMethod(paymentMethod)) {
      throw new Error("MALFORMED_PROVIDER_EVIDENCE");
    }
    await tx.organizationSubscriptionInvoice.upsert({
      where: { razorpayInvoiceId: settlement.invoice.id },
      create: {
        organizationId: candidate.id,
        organizationSubscriptionId: subscription.id,
        razorpayInvoiceId: settlement.invoice.id,
        razorpayPaymentId: settlement.payment.id,
        status: settlement.invoice.status,
        amountSubunits: settlement.invoice.amount,
        amountPaidSubunits: settlement.invoice.amount_paid,
        amountDueSubunits: settlement.invoice.amount_due,
        currency: settlement.invoice.currency.toUpperCase(),
        paymentMethod,
        commercialEvidenceVersion: 1,
        commercialIntentChangeId: change.id,
        providerMode: input.providerMode,
        razorpaySubscriptionId: settlement.providerSubscription.id,
        razorpayPlanId: settlement.providerSubscription.plan_id,
        providerQuantity: settlement.providerSubscription.quantity!,
        razorpayOfferId: settlement.providerSubscription.offer_id ?? null,
        paymentAmountSubunits: settlement.payment.amount,
        paymentCurrency: settlement.payment.currency.toUpperCase(),
        paymentStatus: settlement.payment.status.toLowerCase(),
        paymentCaptured: settlement.payment.captured === true,
        evidenceConfirmedAt: input.now,
        evidenceFailureCode: null,
        periodStart: settlement.periodStart,
        periodEnd: settlement.periodEnd,
        issuedAt: positiveInteger(settlement.invoice.issued_at)
          ? new Date(settlement.invoice.issued_at * 1000)
          : null,
        paidAt: positiveInteger(settlement.invoice.paid_at)
          ? new Date(settlement.invoice.paid_at * 1000)
          : null,
      },
      update: {
        razorpayPaymentId: settlement.payment.id,
        status: settlement.invoice.status,
        amountSubunits: settlement.invoice.amount,
        amountPaidSubunits: settlement.invoice.amount_paid,
        amountDueSubunits: settlement.invoice.amount_due,
        currency: settlement.invoice.currency.toUpperCase(),
        paymentMethod,
        commercialEvidenceVersion: 1,
        commercialIntentChangeId: change.id,
        providerMode: input.providerMode,
        razorpaySubscriptionId: settlement.providerSubscription.id,
        razorpayPlanId: settlement.providerSubscription.plan_id,
        providerQuantity: settlement.providerSubscription.quantity!,
        razorpayOfferId: settlement.providerSubscription.offer_id ?? null,
        paymentAmountSubunits: settlement.payment.amount,
        paymentCurrency: settlement.payment.currency.toUpperCase(),
        paymentStatus: settlement.payment.status.toLowerCase(),
        paymentCaptured: true,
        evidenceConfirmedAt: existingInvoice?.evidenceConfirmedAt ?? input.now,
        evidenceFailureCode: null,
        periodStart: settlement.periodStart,
        periodEnd: settlement.periodEnd,
        issuedAt: providerDate(settlement.invoice.issued_at),
        paidAt: positiveInteger(settlement.invoice.paid_at)
          ? new Date(settlement.invoice.paid_at * 1000)
          : null,
      },
    });
    // Any existing unbacked boundary is untrusted. This transition adopts only
    // the exact period proven by the selected provider invoice and payment.
    const paidThrough = settlement.periodEnd;
    const stored = await tx.organizationSubscription.update({
      where: { id: subscription.id },
      data: {
        plan: intent.authorizedPlan,
        amount: fromRazorpaySubunits(
          intent.authorizedUnitAmountSubunits,
          intent.authorizedCurrency
        ),
        amountSubunits: intent.authorizedUnitAmountSubunits,
        currency: intent.authorizedCurrency,
        period: intent.authorizedPeriod,
        interval: intent.authorizedInterval,
        razorpayPlanId: intent.authorizedRazorpayPlanId,
        quantity: intent.authorizedQuantity,
        status: "ACTIVE",
        authPaymentId: subscription.authPaymentId ?? settlement.payment.id,
        providerPaymentMethod: paymentMethod,
        confirmedCommercialIntentChangeId: change.id,
        providerStartAt: providerDate(settlement.providerSubscription.start_at),
        authorizationExpiresAt: providerDate(settlement.providerSubscription.expire_by),
        currentStart: settlement.periodStart,
        currentEnd: settlement.periodEnd,
        chargeAt: providerDate(settlement.providerSubscription.charge_at),
        endedAt: providerDate(settlement.providerSubscription.ended_at),
        paidThrough,
        lastConfirmedInvoiceId: settlement.invoice.id,
        lastConfirmedPaymentId: settlement.payment.id,
        lastPaymentConfirmedAt: input.now,
        lastReconciledAt: input.now,
      },
    });
    await tx.organizationSubscriptionHistory.upsert({
      where: {
        dedupeKey: `paid:${subscription.razorpaySubscriptionId}:${settlement.invoice.id}`,
      },
      create: {
        organizationId: candidate.id,
        organizationSubscriptionId: subscription.id,
        razorpaySubscriptionId: subscription.razorpaySubscriptionId,
        razorpayPaymentId: settlement.payment.id,
        plan: intent.authorizedPlan,
        fromStatus: subscription.status,
        toStatus: stored.status,
        source: "SYSTEM",
        event: "legacy_paid_entitlement_transition",
        amountSubunits: intent.authorizedUnitAmountSubunits,
        quantity: intent.authorizedQuantity,
        unitAmountSubunits: intent.authorizedUnitAmountSubunits,
        totalAmountSubunits: settlement.invoice.amount,
        paidThrough,
        dedupeKey: `paid:${subscription.razorpaySubscriptionId}:${settlement.invoice.id}`,
        currency: intent.authorizedCurrency,
      },
      update: {},
    });
    if (intent.authorizedRazorpayOfferId) {
      await tx.organizationOfferGrant.updateMany({
        where: {
          organizationId: candidate.id,
          status: "RESERVED",
          billingOffer: {
            providerMode: input.providerMode,
            razorpayOfferId: intent.authorizedRazorpayOfferId,
          },
        },
        data: { status: "REDEEMED", redeemedAt: input.now },
      });
    }
    const applied = await tx.organizationBillingChange.updateMany({
      where: {
        id: change.id,
        status: change.status,
        operationStatus: change.operationStatus,
        updatedAt: change.updatedAt,
        NOT: { status: { in: ["UNDONE", "SUPERSEDED"] } },
      },
      data: {
        status: "APPLIED",
        operationStatus: "APPLIED",
        providerInvoiceId: settlement.invoice.id,
        providerPaymentId: settlement.payment.id,
        providerConfirmedAt: input.now,
        appliedAt: input.now,
        resolvedAt: input.now,
        failureCategory: null,
        failureCode: null,
        lastError: null,
      },
    });
    if (applied.count !== 1) throw new StaleLegacyPaidEntitlementProposalError();
    await recordBillingMutationAudit(tx, {
      changeId: change.id,
      organizationId: candidate.id,
      organizationSubscriptionId: subscription.id,
      attemptCount: change.attemptCount,
      outcome: "PROVIDER_STATE_ADOPTED",
    });
    return { changeId: change.id, applied: true, alreadyApplied: false };
  });
}

async function persistManualReview(input: {
  assessment: LegacyPaidEntitlementInspection;
  code: LegacyPaidEntitlementManualReviewCode;
  now: Date;
}) {
  if (!input.assessment.organizationSubscriptionId) return null;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization"
      WHERE "id" = ${input.assessment.organizationId}
      FOR UPDATE
    `;
    const candidate = await loadLockedCandidate(tx, input.assessment.organizationId);
    if (!candidate
      || candidate.billingModelVersion !== "LEGACY"
      || candidate.billingMutationLeaseToken
      || legacyPaidEntitlementLocalSnapshotHash(candidate)
        !== input.assessment.localSnapshotHash
      || candidate.subscription?.id !== input.assessment.organizationSubscriptionId) {
      return null;
    }
    const subscription = candidate.subscription;
    let change: OrganizationBillingChange;
    if (input.assessment.commercialIntent) {
      const transition = await ensureTransitionRecord({
        tx,
        candidate,
        intent: input.assessment.commercialIntent,
        now: input.now,
      });
      change = transition.status === "APPLIED"
        ? await ensureManualReviewRecord({
            tx,
            candidate,
            intent: input.assessment.commercialIntent,
            code: input.code,
            now: input.now,
          })
        : transition;
    } else {
      change = await ensureManualReviewRecord({
        tx,
        candidate,
        intent: null,
        code: input.code,
        now: input.now,
      });
    }
    if (change.status === "APPLIED") return null;
    const updated = await tx.organizationBillingChange.updateMany({
      where: {
        id: change.id,
        status: change.status,
        operationStatus: change.operationStatus,
        updatedAt: change.updatedAt,
        NOT: { status: { in: ["UNDONE", "SUPERSEDED", "APPLIED"] } },
      },
      data: {
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: input.code,
        lastError: manualReviewMessage(input.code),
        failedAt: change.failedAt ?? input.now,
        resolvedAt: null,
      },
    });
    if (updated.count !== 1) return null;
    await recordBillingMutationAudit(tx, {
      changeId: change.id,
      organizationId: candidate.id,
      organizationSubscriptionId: subscription.id,
      attemptCount: change.attemptCount,
      outcome: change.failureCategory === "MANUAL_REVIEW_REQUIRED"
        ? "MANUAL_REVIEW_RETAINED"
        : "MANUAL_REVIEW_REQUIRED",
      failureCode: input.code,
    });
    return change.id;
  });
}

function publicRow(
  assessment: LegacyPaidEntitlementInspection,
  application: Partial<Pick<
    LegacyPaidEntitlementResultRow,
    "changeId" | "applied" | "persistedManualReview"
  >> = {}
): LegacyPaidEntitlementResultRow {
  const { commercialIntent, verifiedSettlement, ...safe } = assessment;
  void commercialIntent;
  void verifiedSettlement;
  return {
    ...safe,
    changeId: application.changeId ?? null,
    applied: application.applied ?? false,
    persistedManualReview: application.persistedManualReview ?? false,
  };
}

function missingInspection(organizationId: string) {
  const localSnapshotHash = hash({ version: TRANSITION_VERSION, organizationId, missing: true });
  return inspection({
    organizationId,
    organizationSubscriptionId: null,
    razorpaySubscriptionId: null,
    disposition: "NOT_FOUND",
    manualReviewCode: "ORGANIZATION_NOT_FOUND",
    localSnapshotHash,
    proposedPaidThrough: null,
    providerInvoiceId: null,
    providerPaymentId: null,
    commercialIntent: null,
    verifiedSettlement: null,
  });
}

async function reloadLegacyPaidEntitlementCandidate(organizationId: string) {
  return prisma.organization.findUnique({
    where: { id: organizationId },
    select: LEGACY_PAID_ENTITLEMENT_CANDIDATE_SELECT,
  });
}

async function storedEvidenceCounts(
  organizationIds: readonly string[],
  now: Date
) {
  const [organizations, unresolvedManualReview] = await Promise.all([
    prisma.organization.findMany({
      where: { id: { in: [...organizationIds] } },
      select: {
        id: true,
        billingModelVersion: true,
        subscription: { include: BILLING_PAID_EVIDENCE_INCLUDE },
      },
    }),
    prisma.organizationBillingChange.count({
      where: {
        organizationId: { in: [...organizationIds] },
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        resolvedAt: null,
      },
    }),
  ]);
  const legacySubscriptions = organizations.filter(organization =>
    organization.billingModelVersion === "LEGACY" && organization.subscription
  );
  const evidence = legacySubscriptions.map(organization => ({
    subscription: organization.subscription!,
    trustedPaidThrough: resolveTrustedPaidThrough(organization.subscription, now),
  }));
  return {
    requested: organizationIds.length,
    found: organizations.length,
    legacySubscriptions: legacySubscriptions.length,
    statusOnlyPremiumCandidates: evidence.filter(({ subscription, trustedPaidThrough }) =>
      ["AUTHENTICATED", "ACTIVE"].includes(subscription.status)
      && trustedPaidThrough == null
    ).length,
    currentUnbackedPaidThrough: evidence.filter(({ subscription, trustedPaidThrough }) =>
      subscription.paidThrough != null
      && subscription.paidThrough > now
      && trustedPaidThrough == null
    ).length,
    exactBackedCurrentPeriods: evidence.filter(row => row.trustedPaidThrough != null).length,
    unresolvedManualReview,
  };
}

export class LegacyPaidEntitlementTransitionService {
  static async run(options: {
    organizationIds: readonly string[];
    providerMode: RazorpayMode;
    apply?: boolean;
    confirmedBatchProposalHash?: string | null;
    now?: Date;
    provider?: LegacyPaidEntitlementProviderReader;
  }) {
    const organizationIds = [...new Set(options.organizationIds.map(id => id.trim()))]
      .filter(Boolean)
      .sort();
    if (organizationIds.length === 0
      || organizationIds.length !== options.organizationIds.length) {
      throw new Error("An explicit, duplicate-free organization allowlist is required");
    }
    const runtimeMode = resolveRazorpayMode();
    if (runtimeMode !== options.providerMode) {
      throw new Error("Explicit provider mode does not match the configured runtime mode");
    }
    const provider = options.provider ?? getRazorpayClient();
    const now = options.now ?? new Date();
    const preCounts = await storedEvidenceCounts(organizationIds, now);
    const organizations = await prisma.organization.findMany({
      where: { id: { in: organizationIds } },
      select: LEGACY_PAID_ENTITLEMENT_CANDIDATE_SELECT,
      orderBy: { id: "asc" },
    });
    const byId = new Map(organizations.map(organization => [organization.id, organization]));
    const inspections: LegacyPaidEntitlementInspection[] = [];
    for (const organizationId of organizationIds) {
      const candidate = byId.get(organizationId);
      inspections.push(candidate
        ? await inspectLegacyPaidEntitlementCandidate({
            candidate,
            providerMode: options.providerMode,
            provider,
            now,
          })
        : missingInspection(organizationId));
    }
    const batchProposalHash = legacyPaidEntitlementBatchProposalHash(inspections);
    const apply = options.apply === true;
    if (apply && options.confirmedBatchProposalHash !== batchProposalHash) {
      throw new Error(
        "--apply requires the exact batch proposal hash from a fresh dry run"
      );
    }
    const rows: LegacyPaidEntitlementResultRow[] = [];
    for (const assessment of inspections) {
      if (!apply) {
        rows.push(publicRow(assessment));
        continue;
      }
      if (assessment.disposition === "EXACT_SETTLEMENT") {
        try {
          // Apply runs perform a second provider read immediately before the
          // local transaction. A changed provider tuple invalidates the dry-run
          // proposal instead of being adopted from a stale snapshot.
          const candidate = await reloadLegacyPaidEntitlementCandidate(
            assessment.organizationId
          );
          const refreshed = candidate
            ? await inspectLegacyPaidEntitlementCandidate({
                candidate,
                providerMode: options.providerMode,
                provider,
                now,
              })
            : missingInspection(assessment.organizationId);
          if (refreshed.disposition !== "EXACT_SETTLEMENT"
            || refreshed.proposalHash !== assessment.proposalHash) {
            const code = refreshed.manualReviewCode ?? "LOCAL_SNAPSHOT_CHANGED";
            const reviewAssessment: LegacyPaidEntitlementInspection = {
              ...refreshed,
              disposition: "MANUAL_REVIEW_REQUIRED",
              manualReviewCode: code,
            };
            const changeId = refreshed.organizationSubscriptionId
              ? await persistManualReview({ assessment: reviewAssessment, code, now })
              : null;
            rows.push(publicRow(reviewAssessment, {
              changeId,
              persistedManualReview: changeId != null,
            }));
            continue;
          }
          const applied = await applyExactSettlement({
            assessment: refreshed,
            providerMode: options.providerMode,
            now,
          });
          rows.push(publicRow(refreshed, {
            changeId: applied.changeId,
            applied: applied.applied,
          }));
          continue;
        } catch (error) {
          const stale = error instanceof StaleLegacyPaidEntitlementProposalError;
          const code: LegacyPaidEntitlementManualReviewCode = stale
            ? "LOCAL_SNAPSHOT_CHANGED"
            : error instanceof Error
              && error.message === "TRANSITION_STATE_CONFLICT"
              ? "TRANSITION_STATE_CONFLICT"
              : "COMMERCIAL_FINALIZATION_FAILED";
          const changeId = stale
            ? null
            : await persistManualReview({ assessment, code, now });
          rows.push(publicRow({
            ...assessment,
            disposition: "MANUAL_REVIEW_REQUIRED",
            manualReviewCode: code,
          }, {
            changeId,
            persistedManualReview: changeId != null,
          }));
          continue;
        }
      }
      if (assessment.disposition === "MANUAL_REVIEW_REQUIRED"
        && assessment.manualReviewCode) {
        const changeId = await persistManualReview({
          assessment,
          code: assessment.manualReviewCode,
          now,
        });
        rows.push(publicRow(assessment, {
          changeId,
          persistedManualReview: changeId != null,
        }));
        continue;
      }
      rows.push(publicRow(assessment));
    }
    const proposalCounts = {
      requested: organizationIds.length,
      found: organizations.length,
      exactSettlements: rows.filter(row => row.disposition === "EXACT_SETTLEMENT").length,
      alreadyEvidenceBacked: rows.filter(row => row.disposition === "ALREADY_EVIDENCE_BACKED").length,
      manualReviewRequired: rows.filter(row => row.disposition === "MANUAL_REVIEW_REQUIRED").length,
      applied: rows.filter(row => row.applied).length,
      persistedManualReview: rows.filter(row => row.persistedManualReview).length,
      skipped: rows.filter(row => ["NOT_LEGACY", "NO_SUBSCRIPTION", "NOT_FOUND"].includes(row.disposition)).length,
    };
    return {
      mode: apply ? "apply" as const : "dry-run" as const,
      providerMode: options.providerMode,
      batchProposalHash,
      preCounts,
      proposalCounts,
      postCounts: apply
        ? await storedEvidenceCounts(organizationIds, now)
        : preCounts,
      rows,
      providerMutations: 0 as const,
    };
  }
}
