import { BillingManualReviewRequiredError } from "@/lib/billingErrors";
import { prisma } from "@/lib/prisma";
import {
  fromRazorpaySubunits,
  getRazorpayClient,
  resolveRazorpayMode,
  type RazorpayInvoice,
  type RazorpayInvoices,
  type RazorpayPayment,
  type RazorpayPlan,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import {
  commercialEvidenceMessage,
  readCommercialIntentSnapshot,
  validateExactCommercialEvidence,
  type CommercialEvidenceMismatchCode,
  type ExactCommercialEvidenceResult,
} from "@/services/billingCommercialEvidence.service";
import { recordBillingMutationAudit } from "@/services/billingMutationAudit.service";
import {
  isSupportedProviderPaymentMethod,
  normalizeProviderPaymentMethod,
} from "@/services/billingPaymentMethod.service";
import type {
  OrganizationBillingChange,
  OrganizationSubscription,
  Prisma,
  SaasSubscriptionStatus,
} from "@/app/generated/prisma/client";

export type BillingCommercialEvidenceKind =
  | "PENDING"
  | "AUTHORIZATION_ONLY"
  | "EXACT_SETTLEMENT"
  | "DEFINITELY_REJECTED";

type BillingReconciliationResult = {
  subscription: OrganizationSubscription;
  confirmedPaidPeriod: boolean;
  evidenceKind: BillingCommercialEvidenceKind;
  commercialIntentChangeId: string | null;
  payment: RazorpayPayment | null;
  invoices: RazorpayInvoices;
};

type ReconciliationOptions = {
  paymentId?: string | null;
  now?: Date;
  commercialIntentChangeId?: string | null;
  expectedAttemptCount?: number;
  expectedVerificationStartedAt?: Date | null;
};

const SUBSCRIPTION_STATUSES = new Set([
  "CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "PAUSED",
  "CANCELLED", "COMPLETED", "EXPIRED",
]);
const ACTIVE_AUTHORIZATION_STATUSES = [
  "CHECKOUT_OPEN",
  "VERIFYING",
  "AWAITING_PROVIDER_CONFIRMATION",
] as const;

class StaleCommercialReconciliationError extends Error {}

function normalizedProviderStatus(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function status(value: unknown): SaasSubscriptionStatus {
  const normalized = normalizedProviderStatus(value)?.toUpperCase() ?? "PENDING";
  return (SUBSCRIPTION_STATUSES.has(normalized) ? normalized : "PENDING") as SaasSubscriptionStatus;
}

function date(value: number | null | undefined) {
  return value && value > 0 ? new Date(value * 1000) : null;
}

function currentPeriodInvoice(
  subscription: RazorpaySubscription,
  invoices: RazorpayInvoice[]
) {
  return [...invoices]
    .filter(invoice =>
      normalizedProviderStatus(invoice.status) === "paid"
      && invoice.payment_id
      && invoice.subscription_id === subscription.id
      && invoice.billing_start === subscription.current_start
      && invoice.billing_end === subscription.current_end
    )
    .sort((left, right) => (right.paid_at ?? 0) - (left.paid_at ?? 0))[0] ?? null;
}

function hasProviderInvoiceCollectionShape(value: unknown): value is RazorpayInvoices {
  if (!value || typeof value !== "object") return false;
  const collection = value as Record<string, unknown>;
  if (collection.entity !== "collection"
    || !Number.isSafeInteger(collection.count)
    || Number(collection.count) < 0
    || !Array.isArray(collection.items)) return false;
  return collection.items.every(item => {
    if (!item || typeof item !== "object") return false;
    const invoice = item as Record<string, unknown>;
    const optionalId = (candidate: unknown) => candidate == null
      || (typeof candidate === "string" && candidate.trim().length > 0);
    const optionalTimestamp = (candidate: unknown) => candidate == null
      || (Number.isSafeInteger(candidate) && Number(candidate) > 0);
    return invoice.entity === "invoice"
      && typeof invoice.id === "string"
      && invoice.id.trim().length > 0
      && typeof invoice.status === "string"
      && invoice.status.trim().length > 0
      && Number.isSafeInteger(invoice.amount)
      && Number(invoice.amount) > 0
      && Number.isSafeInteger(invoice.amount_paid)
      && Number(invoice.amount_paid) >= 0
      && Number.isSafeInteger(invoice.amount_due)
      && Number(invoice.amount_due) >= 0
      && typeof invoice.currency === "string"
      && invoice.currency.trim().length === 3
      && optionalId(invoice.subscription_id)
      && optionalId(invoice.payment_id)
      && optionalTimestamp(invoice.billing_start)
      && optionalTimestamp(invoice.billing_end)
      && optionalTimestamp(invoice.issued_at)
      && optionalTimestamp(invoice.paid_at);
  });
}

async function resolveCommercialIntent(
  local: OrganizationSubscription,
  now: Date,
  explicitChangeId?: string | null
) {
  if (explicitChangeId) {
    return prisma.organizationBillingChange.findFirst({
      where: {
        id: explicitChangeId,
        organizationId: local.organizationId,
        OR: [
          { organizationSubscriptionId: local.id },
          { replacementSubscriptionId: local.id },
        ],
      },
    });
  }

  const replacement = await prisma.organizationBillingChange.findUnique({
    where: { replacementSubscriptionId: local.id },
  });
  if (replacement) return replacement;

  const authorization = await prisma.organizationBillingChange.findFirst({
    where: {
      organizationId: local.organizationId,
      organizationSubscriptionId: local.id,
      type: "SUBSCRIPTION_AUTHORIZATION",
      operationStatus: { in: [...ACTIVE_AUTHORIZATION_STATUSES] },
    },
    orderBy: { sequence: "desc" },
  });
  if (authorization) return authorization;

  const activeChange = await prisma.organizationBillingChange.findFirst({
    where: {
      organizationId: local.organizationId,
      organizationSubscriptionId: local.id,
      replacementSubscriptionId: null,
      type: { notIn: ["SUBSCRIPTION_AUTHORIZATION", "COMMERCIAL_RECONCILIATION"] },
      commercialIntentVersion: 1,
      OR: [
        { status: "AWAITING_PAYMENT" },
        { status: "SCHEDULED", effectiveAt: { lte: now } },
      ],
    },
    orderBy: { sequence: "asc" },
  });
  if (activeChange) return activeChange;

  const legacyTransition = await prisma.organizationBillingChange.findFirst({
    where: {
      organizationId: local.organizationId,
      organizationSubscriptionId: local.id,
      replacementSubscriptionId: null,
      type: "LEGACY_TRANSITION",
      commercialIntentVersion: 1,
      status: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
    },
    orderBy: { sequence: "desc" },
  });
  if (legacyTransition) return legacyTransition;

  if (!local.confirmedCommercialIntentChangeId) return null;
  return prisma.organizationBillingChange.findFirst({
    where: {
      id: local.confirmedCommercialIntentChangeId,
      organizationId: local.organizationId,
    },
  });
}

function commercialSnapshotOrNull(intent: OrganizationBillingChange | null) {
  if (!intent) return null;
  try {
    return readCommercialIntentSnapshot(intent);
  } catch {
    return null;
  }
}

async function revokeInvalidReplacementAccess(
  tx: Prisma.TransactionClient,
  intent: OrganizationBillingChange,
  now: Date
) {
  if (!intent.replacementSubscriptionId
    || !intent.accessGrantedAt
    || intent.accessRevokedAt) return;
  await tx.organizationBillingChange.updateMany({
    where: { id: intent.id, accessRevokedAt: null },
    data: { accessRevokedAt: now },
  });
  if (!intent.branchId) return;
  if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(intent.type)) {
    await tx.branch.updateMany({
      where: { id: intent.branchId, billingStatus: "ACTIVE" },
      data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
    });
  }
  if (intent.type === "BRANCH_REACTIVATION") {
    await tx.branch.updateMany({
      where: { id: intent.branchId, billingStatus: "ACTIVE" },
      data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
    });
  }
}

async function quarantineCommercialMismatch(input: {
  local: OrganizationSubscription;
  intent: OrganizationBillingChange | null;
  code: CommercialEvidenceMismatchCode;
  now: Date;
  options: ReconciliationOptions;
}): Promise<never> {
  const message = commercialEvidenceMessage(input.code);
  const review = await prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization" WHERE "id" = ${input.local.organizationId} FOR UPDATE
    `;
    const currentLocal = await tx.organizationSubscription.findUnique({
      where: { id: input.local.id },
    });
    if (!currentLocal
      || currentLocal.organizationId !== input.local.organizationId
      || currentLocal.razorpaySubscriptionId !== input.local.razorpaySubscriptionId) {
      throw new StaleCommercialReconciliationError();
    }

    const intent = input.intent
      ? await tx.organizationBillingChange.findUnique({ where: { id: input.intent.id } })
      : null;
    const historicalIntent = Boolean(
      intent
      && currentLocal.confirmedCommercialIntentChangeId === intent.id
      && intent.status === "APPLIED"
      && intent.type !== "COMMERCIAL_RECONCILIATION"
    );

    if (intent && !historicalIntent) {
      const exactCallbackAttempt = input.options.expectedAttemptCount != null
        && input.options.expectedVerificationStartedAt != null;
      const persisted = await tx.organizationBillingChange.updateMany({
        where: exactCallbackAttempt
          ? {
              id: intent.id,
              operationStatus: "VERIFYING",
              attemptCount: input.options.expectedAttemptCount,
              verificationStartedAt: input.options.expectedVerificationStartedAt,
            }
          : {
              id: intent.id,
              status: intent.status,
              operationStatus: intent.operationStatus,
              updatedAt: intent.updatedAt,
              NOT: { status: { in: ["UNDONE", "SUPERSEDED"] } },
            },
        data: {
          status: "FAILED",
          operationStatus: "FAILED",
          failureCategory: "MANUAL_REVIEW_REQUIRED",
          failureCode: input.code,
          lastError: message,
          failedAt: input.now,
          resolvedAt: null,
        },
      });
      if (persisted.count !== 1) {
        const latest = await tx.organizationBillingChange.findUnique({ where: { id: intent.id } });
        if (latest?.failureCategory === "MANUAL_REVIEW_REQUIRED") return latest;
        throw new StaleCommercialReconciliationError();
      }
      await revokeInvalidReplacementAccess(tx, intent, input.now);
      await recordBillingMutationAudit(tx, {
        changeId: intent.id,
        organizationId: intent.organizationId,
        organizationSubscriptionId: intent.organizationSubscriptionId ?? currentLocal.id,
        attemptCount: intent.attemptCount,
        outcome: intent.failureCategory === "MANUAL_REVIEW_REQUIRED"
          ? "MANUAL_REVIEW_RETAINED"
          : "MANUAL_REVIEW_REQUIRED",
        failureCode: input.code,
      });
      return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: intent.id } });
    }

    const sourceIntentId = intent?.id ?? "missing";
    const idempotencyKey = [
      "commercial-reconciliation",
      currentLocal.organizationId,
      currentLocal.id,
      sourceIntentId,
    ].join(":");
    const existing = await tx.organizationBillingChange.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      const retained = await tx.organizationBillingChange.update({
        where: { id: existing.id },
        data: {
          status: "FAILED",
          operationStatus: "FAILED",
          failureCategory: "MANUAL_REVIEW_REQUIRED",
          failureCode: input.code,
          lastError: message,
          failedAt: existing.failedAt ?? input.now,
          resolvedAt: null,
        },
      });
      await recordBillingMutationAudit(tx, {
        changeId: retained.id,
        organizationId: retained.organizationId,
        organizationSubscriptionId: retained.organizationSubscriptionId,
        attemptCount: retained.attemptCount,
        outcome: "MANUAL_REVIEW_RETAINED",
        failureCode: input.code,
      });
      return retained;
    }

    // Some historical/manual rows predate the organization sequence counter.
    // The organization row is locked above, so advance from both durable
    // sources instead of assuming the counter is already caught up.
    const [organization, existingSequence] = await Promise.all([
      tx.organization.findUniqueOrThrow({
        where: { id: currentLocal.organizationId },
        select: { billingMutationSequence: true },
      }),
      tx.organizationBillingChange.aggregate({
        where: { organizationId: currentLocal.organizationId },
        _max: { sequence: true },
      }),
    ]);
    const nextSequence = Math.max(
      organization.billingMutationSequence,
      existingSequence._max.sequence ?? 0
    ) + 1;
    await tx.organization.update({
      where: { id: currentLocal.organizationId },
      data: { billingMutationSequence: nextSequence },
    });
    const snapshot = commercialSnapshotOrNull(intent);
    const created = await tx.organizationBillingChange.create({
      data: {
        organizationId: currentLocal.organizationId,
        organizationSubscriptionId: currentLocal.id,
        sequence: nextSequence,
        idempotencyKey,
        type: "COMMERCIAL_RECONCILIATION",
        status: "FAILED",
        operationStatus: "FAILED",
        fromPlan: currentLocal.plan,
        toPlan: snapshot?.authorizedPlan ?? currentLocal.plan,
        fromQuantity: currentLocal.quantity,
        toQuantity: snapshot?.authorizedQuantity ?? currentLocal.quantity,
        ...(snapshot ?? {}),
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: input.code,
        lastError: message,
        failedAt: input.now,
      },
    });
    await recordBillingMutationAudit(tx, {
      changeId: created.id,
      organizationId: created.organizationId,
      organizationSubscriptionId: created.organizationSubscriptionId,
      attemptCount: created.attemptCount,
      outcome: "MANUAL_REVIEW_REQUIRED",
      failureCode: input.code,
    });
    return created;
  });

  throw new BillingManualReviewRequiredError(review.id, message);
}

function evidenceMatchesStoredInvoice(input: {
  stored: {
    commercialEvidenceVersion: number | null;
    commercialIntentChangeId: string | null;
    providerMode: string | null;
    razorpaySubscriptionId: string | null;
    razorpayPlanId: string | null;
    providerQuantity: number | null;
    razorpayOfferId: string | null;
    paymentAmountSubunits: number | null;
    paymentCurrency: string | null;
    paymentStatus: string | null;
    paymentCaptured: boolean | null;
    periodStart: Date | null;
    periodEnd: Date | null;
  };
  intentId: string;
  providerMode: string;
  providerSubscription: RazorpaySubscription;
  payment: RazorpayPayment;
  periodStart: Date;
  periodEnd: Date;
}) {
  const stored = input.stored;
  return stored.commercialEvidenceVersion === 1
    && stored.commercialIntentChangeId === input.intentId
    && stored.providerMode === input.providerMode
    && stored.razorpaySubscriptionId === input.providerSubscription.id
    && stored.razorpayPlanId === input.providerSubscription.plan_id
    && stored.providerQuantity === input.providerSubscription.quantity
    && stored.razorpayOfferId === (input.providerSubscription.offer_id ?? null)
    && stored.paymentAmountSubunits === input.payment.amount
    && stored.paymentCurrency === input.payment.currency.toUpperCase()
    && stored.paymentStatus?.toLowerCase() === "captured"
    && stored.paymentCaptured === true
    && stored.periodStart?.getTime() === input.periodStart.getTime()
    && stored.periodEnd?.getTime() === input.periodEnd.getTime();
}

export class BillingReconciliationService {
  static async reconcileByOrganization(
    organizationId: string,
    options: ReconciliationOptions = {}
  ) {
    const local = await prisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: organizationId },
    });
    if (!local) throw new Error("Subscription not found");
    return this.reconcileProviderSubscription(local.razorpaySubscriptionId, options);
  }

  static async reconcileProviderSubscription(
    razorpaySubscriptionId: string,
    options: ReconciliationOptions = {},
    staleRetry = 0
  ): Promise<BillingReconciliationResult> {
    const now = options.now ?? new Date();
    const localBeforeFetch = await prisma.organizationSubscription.findUnique({
      where: { razorpaySubscriptionId },
    });
    if (!localBeforeFetch) throw new Error("Subscription not found");
    const providerMode = resolveRazorpayMode();
    if (localBeforeFetch.providerMode !== providerMode) {
      throw new Error(
        `Subscription provider mode ${localBeforeFetch.providerMode} cannot be reconciled in ${providerMode} mode`
      );
    }
    const [intent, organizationSnapshot, sourceReplacement] = await Promise.all([
      resolveCommercialIntent(localBeforeFetch, now, options.commercialIntentChangeId),
      prisma.organization.findUnique({
        where: { id: localBeforeFetch.organizationId },
        select: { billingMutationSequence: true },
      }),
      prisma.organizationBillingChange.findFirst({
        where: {
          organizationId: localBeforeFetch.organizationId,
          organizationSubscriptionId: localBeforeFetch.id,
          replacementSubscriptionId: { not: null },
          status: "SCHEDULED",
          effectiveAt: { not: null },
        },
        orderBy: { sequence: "desc" },
      }),
    ]);
    if (!organizationSnapshot) throw new Error("Organization not found");

    const razorpay = getRazorpayClient();
    const [providerSubscription, invoices, explicitPayment] = await Promise.all([
      razorpay.fetchSubscription(razorpaySubscriptionId),
      razorpay.fetchSubscriptionInvoices(razorpaySubscriptionId),
      options.paymentId ? razorpay.fetchPayment(options.paymentId) : Promise.resolve(null),
    ]);
    if (!hasProviderInvoiceCollectionShape(invoices)) {
      return quarantineCommercialMismatch({
        local: localBeforeFetch,
        intent,
        code: "MALFORMED_PROVIDER_EVIDENCE",
        now,
        options,
      });
    }
    const subscriptionEvidence = validateExactCommercialEvidence({
      intent,
      organizationId: localBeforeFetch.organizationId,
      providerMode,
      localSubscription: localBeforeFetch,
      providerSubscription,
      payment: null,
      invoice: null,
      providerPlan: null,
      now,
    });
    if (subscriptionEvidence.kind === "MISMATCH") {
      return quarantineCommercialMismatch({
        local: localBeforeFetch,
        intent,
        code: subscriptionEvidence.code,
        now,
        options,
      });
    }
    const selectedInvoice = explicitPayment?.invoice_id
      ? invoices.items.find(invoice => invoice.id === explicitPayment.invoice_id) ?? null
      : explicitPayment
        ? null
        : currentPeriodInvoice(providerSubscription, invoices.items);
    const payment = explicitPayment
      ?? (selectedInvoice?.payment_id
        ? await razorpay.fetchPayment(selectedInvoice.payment_id)
        : null);
    const providerPlan: RazorpayPlan | null = selectedInvoice && razorpay.fetchPlan
      ? await razorpay.fetchPlan(providerSubscription.plan_id)
      : null;

    const evidence = validateExactCommercialEvidence({
      intent,
      organizationId: localBeforeFetch.organizationId,
      providerMode,
      localSubscription: localBeforeFetch,
      providerSubscription,
      payment,
      expectedPaymentId: options.paymentId ?? selectedInvoice?.payment_id ?? null,
      invoice: selectedInvoice,
      providerPlan,
      now,
    });

    if (evidence.kind === "MISMATCH"
      && evidence.code === "PAYMENT_NOT_AUTHORIZED") {
      if (normalizedProviderStatus(payment?.status) === "failed") {
        return {
          subscription: localBeforeFetch,
          confirmedPaidPeriod: false,
          evidenceKind: "DEFINITELY_REJECTED",
          commercialIntentChangeId: intent?.id ?? null,
          payment,
          invoices,
        };
      }
    }
    if (evidence.kind === "MISMATCH") {
      return quarantineCommercialMismatch({
        local: localBeforeFetch,
        intent,
        code: evidence.code,
        now,
        options,
      });
    }
    if (evidence.kind === "PENDING") {
      const scheduledReplacement = sourceReplacement;
      const scheduledAt = scheduledReplacement?.effectiveAt
        && providerSubscription.has_scheduled_changes === true
        && providerSubscription.change_scheduled_at
        && providerSubscription.change_scheduled_at > 0
        ? new Date(providerSubscription.change_scheduled_at * 1000)
        : null;
      if (scheduledReplacement
        && scheduledAt
        && scheduledAt.getTime() === scheduledReplacement.effectiveAt!.getTime()) {
        const recovered = await prisma.$transaction(async tx => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Organization" WHERE "id" = ${localBeforeFetch.organizationId} FOR UPDATE
          `;
          const [organization, local, lockedIntent, lockedReplacement] = await Promise.all([
            tx.organization.findUniqueOrThrow({
              where: { id: localBeforeFetch.organizationId },
              select: { billingMutationSequence: true },
            }),
            tx.organizationSubscription.findUniqueOrThrow({ where: { id: localBeforeFetch.id } }),
            intent
              ? tx.organizationBillingChange.findUnique({ where: { id: intent.id } })
              : Promise.resolve(null),
            tx.organizationBillingChange.findUnique({ where: { id: scheduledReplacement.id } }),
          ]);
          if (organization.billingMutationSequence !== organizationSnapshot.billingMutationSequence
            || local.updatedAt.getTime() !== localBeforeFetch.updatedAt.getTime()
            || lockedIntent?.updatedAt.getTime() !== intent?.updatedAt.getTime()
            || lockedReplacement?.updatedAt.getTime() !== scheduledReplacement.updatedAt.getTime()
            || lockedReplacement?.status !== "SCHEDULED"
            || lockedReplacement.effectiveAt?.getTime() !== scheduledAt.getTime()) {
            return { stale: true as const };
          }
          const stored = await tx.organizationSubscription.update({
            where: { id: local.id },
            data: {
              cancelAtCycleEnd: true,
              cancellationRequestedAt: local.cancellationRequestedAt ?? now,
              cancellationScheduledAt: scheduledAt,
              lastReconciledAt: now,
            },
          });
          const confirmed = await tx.organizationBillingChange.updateMany({
            where: {
              id: lockedReplacement.id,
              status: "SCHEDULED",
              operationStatus: lockedReplacement.operationStatus,
              updatedAt: lockedReplacement.updatedAt,
            },
            data: {
              operationStatus: "SCHEDULED",
              providerConfirmedAt: lockedReplacement.providerConfirmedAt ?? now,
              lastError: null,
            },
          });
          if (confirmed.count !== 1) return { stale: true as const };
          return { stale: false as const, stored };
        });
        if (recovered.stale) {
          if (staleRetry >= 2) throw new StaleCommercialReconciliationError();
          return this.reconcileProviderSubscription(razorpaySubscriptionId, options, staleRetry + 1);
        }
        return {
          subscription: recovered.stored,
          confirmedPaidPeriod: false,
          evidenceKind: "PENDING",
          commercialIntentChangeId: intent?.id ?? null,
          payment,
          invoices,
        };
      }
      return {
        subscription: localBeforeFetch,
        confirmedPaidPeriod: false,
        evidenceKind: "PENDING",
        commercialIntentChangeId: intent?.id ?? null,
        payment,
        invoices,
      };
    }

    const paymentMethod = normalizeProviderPaymentMethod(payment?.method);
    if (!payment || !isSupportedProviderPaymentMethod(paymentMethod)) {
      return quarantineCommercialMismatch({
        local: localBeforeFetch,
        intent,
        code: "MALFORMED_PROVIDER_EVIDENCE",
        now,
        options,
      });
    }

    if (evidence.kind === "AUTHORIZATION_ONLY") {
      try {
        const authorization = await prisma.$transaction(async tx => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Organization" WHERE "id" = ${localBeforeFetch.organizationId} FOR UPDATE
          `;
          const organization = await tx.organization.findUniqueOrThrow({
            where: { id: localBeforeFetch.organizationId },
            select: { billingMutationSequence: true },
          });
          const local = await tx.organizationSubscription.findUniqueOrThrow({
            where: { id: localBeforeFetch.id },
          });
          const lockedIntent = intent
            ? await tx.organizationBillingChange.findUnique({ where: { id: intent.id } })
            : null;
          if (organization.billingMutationSequence !== organizationSnapshot.billingMutationSequence
            || local.updatedAt.getTime() !== localBeforeFetch.updatedAt.getTime()
            || lockedIntent?.updatedAt.getTime() !== intent?.updatedAt.getTime()) {
            return { stale: true as const };
          }
          if (options.expectedAttemptCount != null
            && options.expectedVerificationStartedAt != null
            && (lockedIntent?.operationStatus !== "VERIFYING"
              || lockedIntent.attemptCount !== options.expectedAttemptCount
              || lockedIntent.verificationStartedAt?.getTime()
                !== options.expectedVerificationStartedAt.getTime())) {
            return { stale: true as const };
          }
          const lockedEvidence = validateExactCommercialEvidence({
            intent: lockedIntent,
            organizationId: local.organizationId,
            providerMode,
            localSubscription: local,
            providerSubscription,
            payment,
            expectedPaymentId: options.paymentId ?? payment.id,
            invoice: null,
            providerPlan: null,
            now,
          });
          if (lockedEvidence.kind !== "AUTHORIZATION_ONLY" || !lockedIntent) {
            return { mismatch: lockedEvidence };
          }
          let providerStatus = status(providerSubscription.status);
          if (providerStatus === "CREATED" && paymentMethod !== "EMANDATE") {
            providerStatus = "AUTHENTICATED";
          }
          const stored = await tx.organizationSubscription.update({
            where: { id: local.id },
            data: {
              status: providerStatus,
              authPaymentId: payment.id,
              providerPaymentMethod: paymentMethod,
              confirmedCommercialIntentChangeId: lockedIntent.id,
              providerStartAt: date(providerSubscription.start_at),
              authorizationExpiresAt: date(providerSubscription.expire_by),
              currentStart: date(providerSubscription.current_start),
              currentEnd: date(providerSubscription.current_end),
              chargeAt: date(providerSubscription.charge_at),
              endedAt: date(providerSubscription.ended_at),
              lastReconciledAt: now,
            },
          });
          return { stale: false as const, stored };
        });
        if ("stale" in authorization && authorization.stale) {
          if (staleRetry >= 2) throw new StaleCommercialReconciliationError();
          return this.reconcileProviderSubscription(razorpaySubscriptionId, options, staleRetry + 1);
        }
        if ("mismatch" in authorization) {
          const mismatch = authorization.mismatch as ExactCommercialEvidenceResult;
          return quarantineCommercialMismatch({
            local: localBeforeFetch,
            intent,
            code: mismatch.kind === "MISMATCH"
              ? mismatch.code
              : "MALFORMED_PROVIDER_EVIDENCE",
            now,
            options,
          });
        }
        return {
          subscription: authorization.stored,
          confirmedPaidPeriod: false,
          evidenceKind: "AUTHORIZATION_ONLY",
          commercialIntentChangeId: intent?.id ?? null,
          payment,
          invoices,
        };
      } catch (error) {
        if (error instanceof BillingManualReviewRequiredError) throw error;
        return quarantineCommercialMismatch({
          local: localBeforeFetch,
          intent,
          code: "COMMERCIAL_FINALIZATION_FAILED",
          now,
          options,
        });
      }
    }

    if (!selectedInvoice || !providerPlan || evidence.kind !== "EXACT_SETTLEMENT" || !intent) {
      return quarantineCommercialMismatch({
        local: localBeforeFetch,
        intent,
        code: "MALFORMED_PROVIDER_EVIDENCE",
        now,
        options,
      });
    }
    const settlement = evidence;

    try {
      const reconciliation = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${localBeforeFetch.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: localBeforeFetch.organizationId },
          select: { billingMutationSequence: true },
        });
        const local = await tx.organizationSubscription.findUniqueOrThrow({
          where: { id: localBeforeFetch.id },
        });
        const lockedIntent = await tx.organizationBillingChange.findUnique({
          where: { id: intent.id },
        });
        if (organization.billingMutationSequence !== organizationSnapshot.billingMutationSequence
          || local.updatedAt.getTime() !== localBeforeFetch.updatedAt.getTime()
          || lockedIntent?.updatedAt.getTime() !== intent.updatedAt.getTime()) {
          return { stale: true as const };
        }
        const lockedEvidence = validateExactCommercialEvidence({
          intent: lockedIntent,
          organizationId: local.organizationId,
          providerMode,
          localSubscription: local,
          providerSubscription,
          payment,
          expectedPaymentId: options.paymentId ?? payment.id,
          invoice: selectedInvoice,
          providerPlan,
          now,
        });
        if (lockedEvidence.kind !== "EXACT_SETTLEMENT" || !lockedIntent) {
          return { mismatch: lockedEvidence };
        }

        const existingEvidence = await tx.organizationSubscriptionInvoice.findUnique({
          where: { razorpayInvoiceId: selectedInvoice.id },
        });
        if (existingEvidence?.commercialEvidenceVersion != null
          && !evidenceMatchesStoredInvoice({
            stored: existingEvidence,
            intentId: lockedIntent.id,
            providerMode,
            providerSubscription,
            payment,
            periodStart: lockedEvidence.periodStart,
            periodEnd: lockedEvidence.periodEnd,
          })) {
          return {
            mismatch: {
              kind: "MISMATCH" as const,
              code: "MALFORMED_PROVIDER_EVIDENCE" as const,
            },
          };
        }

        for (const invoice of invoices.items) {
          const exactInvoice = invoice.id === selectedInvoice.id;
          await tx.organizationSubscriptionInvoice.upsert({
            where: { razorpayInvoiceId: invoice.id },
            create: {
              organizationId: local.organizationId,
              organizationSubscriptionId: local.id,
              razorpayInvoiceId: invoice.id,
              razorpayPaymentId: invoice.payment_id ?? null,
              status: invoice.status,
              amountSubunits: invoice.amount,
              amountPaidSubunits: invoice.amount_paid,
              amountDueSubunits: invoice.amount_due,
              currency: invoice.currency.toUpperCase(),
              paymentMethod: exactInvoice ? paymentMethod : "UNKNOWN",
              periodStart: date(invoice.billing_start),
              periodEnd: date(invoice.billing_end),
              issuedAt: date(invoice.issued_at),
              paidAt: date(invoice.paid_at),
              ...(exactInvoice
                ? {
                    commercialEvidenceVersion: 1,
                    commercialIntentChangeId: lockedIntent.id,
                    providerMode,
                    razorpaySubscriptionId: providerSubscription.id,
                    razorpayPlanId: providerSubscription.plan_id,
                    providerQuantity: providerSubscription.quantity!,
                    razorpayOfferId: providerSubscription.offer_id ?? null,
                    paymentAmountSubunits: payment.amount,
                    paymentCurrency: payment.currency.toUpperCase(),
                    paymentStatus: payment.status.toLowerCase(),
                    paymentCaptured: payment.captured === true,
                    evidenceConfirmedAt: now,
                    evidenceFailureCode: null,
                  }
                : {}),
            },
            update: {
              razorpayPaymentId: invoice.payment_id ?? undefined,
              status: invoice.status,
              amountPaidSubunits: invoice.amount_paid,
              amountDueSubunits: invoice.amount_due,
              periodStart: date(invoice.billing_start),
              periodEnd: date(invoice.billing_end),
              paidAt: date(invoice.paid_at),
              ...(exactInvoice
                ? {
                    paymentMethod,
                    commercialEvidenceVersion: 1,
                    commercialIntentChangeId: lockedIntent.id,
                    providerMode,
                    razorpaySubscriptionId: providerSubscription.id,
                    razorpayPlanId: providerSubscription.plan_id,
                    providerQuantity: providerSubscription.quantity!,
                    razorpayOfferId: providerSubscription.offer_id ?? null,
                    paymentAmountSubunits: payment.amount,
                    paymentCurrency: payment.currency.toUpperCase(),
                    paymentStatus: payment.status.toLowerCase(),
                    paymentCaptured: payment.captured === true,
                    evidenceConfirmedAt: existingEvidence?.evidenceConfirmedAt ?? now,
                    evidenceFailureCode: null,
                  }
                : {}),
            },
          });
        }

        const frozen = readCommercialIntentSnapshot(lockedIntent, {
          requireBoundSubscription: true,
        });
        const paidThrough = !local.paidThrough || settlement.periodEnd > local.paidThrough
          ? settlement.periodEnd
          : local.paidThrough;
        const stored = await tx.organizationSubscription.update({
          where: { id: local.id },
          data: {
            plan: frozen.authorizedPlan,
            amount: fromRazorpaySubunits(
              frozen.authorizedUnitAmountSubunits,
              frozen.authorizedCurrency
            ),
            amountSubunits: frozen.authorizedUnitAmountSubunits,
            currency: frozen.authorizedCurrency,
            period: frozen.authorizedPeriod,
            interval: frozen.authorizedInterval,
            razorpayPlanId: frozen.authorizedRazorpayPlanId,
            quantity: frozen.authorizedQuantity,
            status: status(providerSubscription.status),
            authPaymentId: local.authPaymentId ?? payment.id,
            providerPaymentMethod: paymentMethod,
            confirmedCommercialIntentChangeId: lockedIntent.id,
            providerStartAt: date(providerSubscription.start_at),
            authorizationExpiresAt: date(providerSubscription.expire_by),
            currentStart: settlement.periodStart,
            currentEnd: settlement.periodEnd,
            chargeAt: date(providerSubscription.charge_at),
            endedAt: date(providerSubscription.ended_at),
            paidThrough,
            lastConfirmedInvoiceId: selectedInvoice.id,
            lastConfirmedPaymentId: payment.id,
            lastPaymentConfirmedAt: now,
            lastReconciledAt: now,
          },
        });

        await tx.organizationSubscriptionHistory.upsert({
          where: { dedupeKey: `paid:${local.razorpaySubscriptionId}:${selectedInvoice.id}` },
          create: {
            organizationId: local.organizationId,
            organizationSubscriptionId: local.id,
            razorpaySubscriptionId: local.razorpaySubscriptionId,
            razorpayPaymentId: payment.id,
            plan: frozen.authorizedPlan,
            fromStatus: local.status,
            toStatus: stored.status,
            source: "WEBHOOK",
            event: "provider_paid_period_confirmed",
            amountSubunits: frozen.authorizedUnitAmountSubunits,
            quantity: frozen.authorizedQuantity,
            unitAmountSubunits: frozen.authorizedUnitAmountSubunits,
            totalAmountSubunits: selectedInvoice.amount,
            paidThrough,
            dedupeKey: `paid:${local.razorpaySubscriptionId}:${selectedInvoice.id}`,
            currency: frozen.authorizedCurrency,
          },
          update: {},
        });

        if (frozen.authorizedRazorpayOfferId) {
          await tx.organizationOfferGrant.updateMany({
            where: {
              organizationId: local.organizationId,
              status: "RESERVED",
              billingOffer: {
                providerMode,
                razorpayOfferId: frozen.authorizedRazorpayOfferId,
              },
            },
            data: { status: "REDEEMED", redeemedAt: now },
          });
        }

        const replacement = lockedIntent.replacementSubscriptionId === local.id;
        if (replacement) {
          const retainsManualReview = lockedIntent.failureCategory === "MANUAL_REVIEW_REQUIRED";
          const recorded = await tx.organizationBillingChange.updateMany({
            where: {
              id: lockedIntent.id,
              status: lockedIntent.status,
              operationStatus: lockedIntent.operationStatus,
              updatedAt: lockedIntent.updatedAt,
            },
            data: {
              providerInvoiceId: selectedInvoice.id,
              providerPaymentId: payment.id,
              providerConfirmedAt: now,
              ...(retainsManualReview
                ? {}
                : {
                    failureCategory: null,
                    failureCode: null,
                    lastError: null,
                  }),
            },
          });
          if (recorded.count !== 1) throw new StaleCommercialReconciliationError();
        } else if (lockedIntent.status !== "APPLIED"
          || lockedIntent.type === "COMMERCIAL_RECONCILIATION") {
          const applied = await tx.organizationBillingChange.updateMany({
            where: options.expectedAttemptCount != null
              && options.expectedVerificationStartedAt != null
              ? {
                  id: lockedIntent.id,
                  operationStatus: "VERIFYING",
                  attemptCount: options.expectedAttemptCount,
                  verificationStartedAt: options.expectedVerificationStartedAt,
                }
              : {
                  id: lockedIntent.id,
                  status: lockedIntent.status,
                  operationStatus: lockedIntent.operationStatus,
                  updatedAt: lockedIntent.updatedAt,
                },
            data: {
              status: "APPLIED",
              operationStatus: "APPLIED",
              providerInvoiceId: selectedInvoice.id,
              providerPaymentId: payment.id,
              providerConfirmedAt: now,
              appliedAt: now,
              resolvedAt: now,
              failureCategory: null,
              failureCode: null,
              lastError: null,
            },
          });
          if (applied.count !== 1) throw new StaleCommercialReconciliationError();
          if (lockedIntent.type === "COMMERCIAL_RECONCILIATION"
            || lockedIntent.failureCategory === "MANUAL_REVIEW_REQUIRED") {
            await recordBillingMutationAudit(tx, {
              changeId: lockedIntent.id,
              organizationId: lockedIntent.organizationId,
              organizationSubscriptionId: lockedIntent.organizationSubscriptionId,
              attemptCount: lockedIntent.attemptCount,
              outcome: "PROVIDER_STATE_ADOPTED",
            });
          }
          if (lockedIntent.branchId
            && ["QUANTITY_INCREASE", "BRANCH_REACTIVATION"].includes(lockedIntent.type)) {
            await tx.branch.update({
              where: { id: lockedIntent.branchId },
              data: { billingStatus: "ACTIVE", billingActivatedAt: now, billingArchivedAt: null },
            });
          }
          if (lockedIntent.branchId && lockedIntent.type === "BRANCH_REMOVAL") {
            await tx.branch.update({
              where: { id: lockedIntent.branchId },
              data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
            });
          }
        }

        return { stale: false as const, subscription: stored };
      });

      if ("stale" in reconciliation && reconciliation.stale) {
        if (staleRetry >= 2) throw new StaleCommercialReconciliationError();
        return this.reconcileProviderSubscription(razorpaySubscriptionId, options, staleRetry + 1);
      }
      if ("mismatch" in reconciliation) {
        const mismatch = reconciliation.mismatch as ExactCommercialEvidenceResult;
        return quarantineCommercialMismatch({
          local: localBeforeFetch,
          intent,
          code: mismatch.kind === "MISMATCH"
            ? mismatch.code
            : "MALFORMED_PROVIDER_EVIDENCE",
          now,
          options,
        });
      }
      return {
        subscription: reconciliation.subscription,
        confirmedPaidPeriod: true,
        evidenceKind: "EXACT_SETTLEMENT",
        commercialIntentChangeId: intent?.id ?? null,
        payment,
        invoices,
      };
    } catch (error) {
      if (error instanceof BillingManualReviewRequiredError) throw error;
      if (error instanceof StaleCommercialReconciliationError && staleRetry < 2) {
        return this.reconcileProviderSubscription(razorpaySubscriptionId, options, staleRetry + 1);
      }
      return quarantineCommercialMismatch({
        local: localBeforeFetch,
        intent,
        code: "COMMERCIAL_FINALIZATION_FAILED",
        now,
        options,
      });
    }
  }
}
