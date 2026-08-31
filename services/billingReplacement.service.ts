import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
  BillingReplacementNotReadyError,
} from "@/lib/billingErrors";
import {
  getRazorpayClient,
  fromRazorpaySubunits,
  RazorpayApiError,
  resolveRazorpayMode,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import { getBillingPlan } from "@/lib/billingPlans";
import { assertRazorpayBillingWritesEnabled } from "@/lib/billingFeature";
import { ensureRazorpayPlanCatalogEntry } from "@/services/razorpayPlanCatalog.service";
import { normalizeProviderPaymentMethod } from "@/services/billingPaymentMethod.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { recordBillingMutationAudit } from "@/services/billingMutationAudit.service";
import {
  buildCommercialIntentSnapshot,
  captureProcessingCommercialIntent,
  readCommercialIntentSnapshot,
} from "@/services/billingCommercialEvidence.service";
import {
  addCalendarMonthsUtc,
  getReplacementChargeGraceEndsAt,
  getReplacementUndoCutoffAt,
  getSafeReplacementCycleBoundary,
  isReplacementAuthorizationReady,
  isReplacementMutationEligible,
  isReplacementPromotionReady,
  isSupportedRecurringPaymentMethod,
  normalizeReplacementPaymentMethod,
} from "@/services/billingReplacementPolicy";
import type {
  BillingChangeType,
  OrganizationBillingChange,
  OrganizationSubscription,
  Prisma,
  SaasSubscriptionStatus,
} from "@/app/generated/prisma/client";

const TERMINAL_PROVIDER_STATUSES = new Set(["cancelled", "completed", "expired"]);
const OPEN_CHANGE_STATUSES = ["QUEUED", "PROCESSING", "AWAITING_PAYMENT", "SCHEDULED"] as const;
const REPLACEMENT_PROVIDER_LEASE_MS = 2 * 60 * 1000;
const CANDIDATE_CANCELLATION_PROCESSING_CODE = "CANDIDATE_CANCELLATION_PROCESSING";
const CANDIDATE_CANCELLATION_OUTCOME_UNKNOWN_CODE = "CANDIDATE_CANCELLATION_OUTCOME_UNKNOWN";
const CANDIDATE_CANCELLATION_PROVIDER_REJECTED_CODE = "CANDIDATE_CANCELLATION_PROVIDER_REJECTED";
const CANDIDATE_CANCELLATION_LEASE_EXPIRED_CODE = "CANDIDATE_CANCELLATION_LEASE_EXPIRED";
const CANDIDATE_CANCELLATION_RETRY_SAFE_CODE = "CANDIDATE_CANCELLATION_RETRY_SAFE";
const REPLACEMENT_UNDO_CANCELLATION_PROCESSING_PREFIX = "REPLACEMENT_UNDO_CANCELLATION_PROCESSING_";
const REPLACEMENT_UNDO_CANCELLATION_OUTCOME_UNKNOWN_PREFIX = "REPLACEMENT_UNDO_CANCELLATION_OUTCOME_UNKNOWN_";
const REPLACEMENT_UNDO_CANCELLATION_PROVIDER_REJECTED_PREFIX = "REPLACEMENT_UNDO_CANCELLATION_PROVIDER_REJECTED_";
const REPLACEMENT_UNDO_CANCELLATION_LEASE_EXPIRED_PREFIX = "REPLACEMENT_UNDO_CANCELLATION_LEASE_EXPIRED_";
const REPLACEMENT_UNDO_CANCELLATION_RETRY_SAFE_PREFIX = "REPLACEMENT_UNDO_CANCELLATION_RETRY_SAFE_";
const TRUSTWORTHY_REPLACEMENT_ACCESS_STATUSES = new Set(["AUTHENTICATED", "ACTIVE"]);
const IMMEDIATE_ACCESS_CHANGE_TYPES = new Set([
  "TRIAL_SUBSCRIPTION_UPDATE",
  "PLAN_UPGRADE",
  "QUANTITY_INCREASE",
  "BRANCH_REACTIVATION",
]);

export type ReplacementAccessAction = "GRANT" | "REVOKE" | "NONE";

type SyncAuthorizedAccessOptions = {
  resolveManualReview?: boolean;
};

export type ReplacementAccessDecisionInput = {
  changeType: string;
  changeStatus: string;
  failureCategory: string | null | undefined;
  sourcePlan: string;
  sourceQuantity: number;
  targetPlan: string;
  targetQuantity: number;
  candidatePlan: string;
  candidateQuantity: number;
  candidateStatus: string;
  candidatePaymentMethod: string | null | undefined;
  candidateProviderPlanId: string;
  targetProviderPlanId: string | null | undefined;
  accessGrantedAt: Date | null;
  accessRevokedAt: Date | null;
  effectiveAt: Date | null;
  accessGraceEndsAt: Date | null;
  now: Date;
};

type ReplacementAccessTrustInput = Pick<
  ReplacementAccessDecisionInput,
  | "changeStatus"
  | "failureCategory"
  | "candidateStatus"
  | "candidatePaymentMethod"
  | "effectiveAt"
  | "accessGraceEndsAt"
  | "now"
>;

function hasTrustworthyReplacementAccessState(input: ReplacementAccessTrustInput) {
  if (!OPEN_CHANGE_STATUSES.includes(
    input.changeStatus as typeof OPEN_CHANGE_STATUSES[number]
  ) || input.failureCategory === "MANUAL_REVIEW_REQUIRED") return false;
  if (!isSupportedRecurringPaymentMethod(input.candidatePaymentMethod)) return false;

  const candidateStatus = input.candidateStatus.trim().toUpperCase();
  if (TRUSTWORTHY_REPLACEMENT_ACCESS_STATUSES.has(candidateStatus)) return true;

  return candidateStatus === "PENDING"
    && normalizeReplacementPaymentMethod(input.candidatePaymentMethod) === "EMANDATE"
    && input.effectiveAt != null
    && input.now >= input.effectiveAt
    && input.accessGraceEndsAt != null
    && input.now < input.accessGraceEndsAt;
}

function planRank(plan: string) {
  if (plan === "PRO") return 2;
  if (plan === "BASIC") return 1;
  return 0;
}

function isImmediateAccessIncrease(input: Pick<
  ReplacementAccessDecisionInput,
  "changeType" | "sourcePlan" | "sourceQuantity" | "targetPlan" | "targetQuantity"
>) {
  if (!IMMEDIATE_ACCESS_CHANGE_TYPES.has(input.changeType)) return false;
  if (planRank(input.targetPlan) < planRank(input.sourcePlan)) return false;
  if (input.changeType === "TRIAL_SUBSCRIPTION_UPDATE") {
    return input.targetQuantity >= input.sourceQuantity
      && (
        planRank(input.targetPlan) > planRank(input.sourcePlan)
        || input.targetQuantity > input.sourceQuantity
      );
  }
  if (input.changeType === "PLAN_UPGRADE") {
    return planRank(input.targetPlan) > planRank(input.sourcePlan)
      && input.targetQuantity >= input.sourceQuantity;
  }
  return input.targetPlan === input.sourcePlan
    && input.targetQuantity > input.sourceQuantity;
}

/**
 * Decides whether complimentary replacement access may be changed. This is
 * deliberately independent from canonical billing promotion: authorization
 * can grant an upgrade/addition, while downgrades and removals wait for the
 * paid cutover.
 */
export function getReplacementAccessAction(
  input: ReplacementAccessDecisionInput
): ReplacementAccessAction {
  if (input.changeStatus === "APPLIED" || input.accessRevokedAt) return "NONE";
  if (!hasTrustworthyReplacementAccessState(input)) {
    return input.accessGrantedAt ? "REVOKE" : "NONE";
  }
  if (input.accessGrantedAt || !isImmediateAccessIncrease(input)) return "NONE";
  if (input.candidatePlan !== input.targetPlan
    || input.candidateQuantity !== input.targetQuantity
    || !input.targetProviderPlanId) return "NONE";
  return isReplacementAuthorizationReady({
    providerStatus: input.candidateStatus,
    paymentMethod: input.candidatePaymentMethod,
    providerPlanId: input.candidateProviderPlanId,
    providerQuantity: input.candidateQuantity,
    targetPlanId: input.targetProviderPlanId,
    targetQuantity: input.targetQuantity,
  }) ? "GRANT" : "NONE";
}

export type AuthorizedReplacementOverrideInput = {
  changeType: string;
  changeStatus: string;
  failureCategory: string | null | undefined;
  sourceSubscriptionId: string;
  changeSourceSubscriptionId: string | null;
  candidateSubscriptionId: string;
  changeCandidateSubscriptionId: string | null;
  sourcePlan: string;
  sourceQuantity: number;
  candidatePlan: string;
  candidateQuantity: number;
  candidateStatus: string;
  candidatePaymentMethod: string | null | undefined;
  accessGrantedAt: Date | null;
  accessRevokedAt: Date | null;
  effectiveAt: Date | null;
  accessGraceEndsAt: Date | null;
  now: Date;
};

/** Returns the fail-closed read override represented by a granted change. */
export function deriveAuthorizedReplacementOverride(
  input: AuthorizedReplacementOverrideInput
) {
  if (!input.accessGrantedAt || input.accessRevokedAt) return null;
  if (input.changeSourceSubscriptionId !== input.sourceSubscriptionId
    || input.changeCandidateSubscriptionId !== input.candidateSubscriptionId) return null;
  if (!hasTrustworthyReplacementAccessState(input)) return null;
  if (!isSupportedRecurringPaymentMethod(input.candidatePaymentMethod)) return null;
  if (!isImmediateAccessIncrease({
    changeType: input.changeType,
    sourcePlan: input.sourcePlan,
    sourceQuantity: input.sourceQuantity,
    targetPlan: input.candidatePlan,
    targetQuantity: input.candidateQuantity,
  })) return null;
  return {
    plan: input.candidatePlan,
    accessGrantedAt: input.accessGrantedAt,
    accessRevokedAt: input.accessRevokedAt,
    graceEndsAt: normalizeReplacementPaymentMethod(input.candidatePaymentMethod) === "EMANDATE"
      ? input.accessGraceEndsAt
      : null,
  };
}

type ReplacementWithSource = OrganizationBillingChange & {
  organizationSubscription: (OrganizationSubscription & {
    billingOffer: {
      durationType: "SINGLE_USE" | "LIMITED_CYCLES";
      durationCycles: number;
    } | null;
  }) | null;
  replacementSubscription: OrganizationSubscription | null;
};

type CandidateCancellationIntent = "FAILURE" | "UNDO_RESTORE" | "UNDO_ARCHIVE";

type ReplacementCancellationChange = OrganizationBillingChange & {
  organizationSubscription: OrganizationSubscription | null;
  replacementSubscription: OrganizationSubscription | null;
};

function dateFromTimestamp(value: number | null | undefined) {
  return value && value > 0 ? new Date(value * 1000) : null;
}

function timestamp(value: Date) {
  return Math.floor(value.getTime() / 1000);
}

function mapProviderStatus(value: unknown): SaasSubscriptionStatus {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "PENDING";
  return [
    "CREATED",
    "AUTHENTICATED",
    "ACTIVE",
    "PENDING",
    "PAUSED",
    "HALTED",
    "CANCELLED",
    "COMPLETED",
    "EXPIRED",
  ].includes(normalized)
    ? normalized as SaasSubscriptionStatus
    : "PENDING";
}

function isDefinitelyRejectedProviderError(error: unknown) {
  return error instanceof RazorpayApiError
    && error.status !== 408
    && ["AUTHENTICATION", "NOT_FOUND", "RATE_LIMIT", "REQUEST"].includes(error.kind);
}

function cancellationErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Razorpay cancellation outcome is unknown";
}

function undoCancellationCode(prefix: string, intent: CandidateCancellationIntent) {
  return `${prefix}${intent === "UNDO_ARCHIVE" ? "ARCHIVE" : "RESTORE"}`;
}

function candidateCancellationIntentFromChange(
  change: Pick<OrganizationBillingChange, "failureCode" | "operationStatus">
): CandidateCancellationIntent | null {
  const code = change.failureCode ?? "";
  if (code.startsWith(REPLACEMENT_UNDO_CANCELLATION_PROCESSING_PREFIX)
    || code.startsWith(REPLACEMENT_UNDO_CANCELLATION_OUTCOME_UNKNOWN_PREFIX)
    || code.startsWith(REPLACEMENT_UNDO_CANCELLATION_PROVIDER_REJECTED_PREFIX)
    || code.startsWith(REPLACEMENT_UNDO_CANCELLATION_LEASE_EXPIRED_PREFIX)) {
    return code.endsWith("ARCHIVE") ? "UNDO_ARCHIVE" : "UNDO_RESTORE";
  }
  if ([
    "CANDIDATE_CANCELLATION_PENDING",
    CANDIDATE_CANCELLATION_PROCESSING_CODE,
    CANDIDATE_CANCELLATION_OUTCOME_UNKNOWN_CODE,
    CANDIDATE_CANCELLATION_PROVIDER_REJECTED_CODE,
    CANDIDATE_CANCELLATION_LEASE_EXPIRED_CODE,
  ].includes(code)) return "FAILURE";
  return null;
}

export function isCandidateCancellationReconciliationCode(code: string | null | undefined) {
  return candidateCancellationIntentFromChange({
    failureCode: code ?? null,
    operationStatus: "FAILED",
  }) != null;
}

function candidateCancellationRetryIntent(code: string | null | undefined): CandidateCancellationIntent | null {
  if (code === CANDIDATE_CANCELLATION_RETRY_SAFE_CODE) return "FAILURE";
  if (code?.startsWith(REPLACEMENT_UNDO_CANCELLATION_RETRY_SAFE_PREFIX)) {
    return code.endsWith("ARCHIVE") ? "UNDO_ARCHIVE" : "UNDO_RESTORE";
  }
  return null;
}

export function isCandidateCancellationRetrySafeCode(code: string | null | undefined) {
  return candidateCancellationRetryIntent(code) != null;
}

function assertExactCandidateSubscriptionResponse(
  value: unknown,
  candidate: Pick<OrganizationSubscription, "razorpaySubscriptionId" | "razorpayPlanId" | "quantity">
): asserts value is RazorpaySubscription {
  if (!value || typeof value !== "object") {
    throw new Error("Razorpay returned a malformed replacement cancellation response");
  }
  const provider = value as Partial<RazorpaySubscription>;
  if (provider.entity !== "subscription"
    || provider.id !== candidate.razorpaySubscriptionId
    || provider.plan_id !== candidate.razorpayPlanId
    || provider.quantity !== candidate.quantity
    || typeof provider.status !== "string"
    || ![
      "created", "authenticated", "active", "pending", "paused", "halted",
      "cancelled", "completed", "expired",
    ].includes(provider.status.toLowerCase())) {
    throw new Error("Razorpay did not return the exact replacement candidate");
  }
}

function assertTerminalCandidateCancellationResponse(
  value: unknown,
  candidate: Pick<OrganizationSubscription, "razorpaySubscriptionId" | "razorpayPlanId" | "quantity">
): asserts value is RazorpaySubscription {
  assertExactCandidateSubscriptionResponse(value, candidate);
  if (!TERMINAL_PROVIDER_STATUSES.has(value.status.toLowerCase())) {
    throw new Error("Razorpay did not confirm the exact replacement candidate cancellation");
  }
}

function getDefaultSubscriptionCycles() {
  const raw = process.env.RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES;
  if (raw == null || raw.trim() === "") return 120;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1200) {
    throw new Error("RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES must be an integer from 1 to 1200");
  }
  return parsed;
}

function intervalMonths(subscription: Pick<OrganizationSubscription, "period" | "interval">) {
  const period = subscription.period.trim().toLowerCase();
  if (period === "yearly" || period === "annual") return subscription.interval * 12;
  if (period !== "monthly") {
    throw new Error(`Replacement scheduling does not support the ${subscription.period} period`);
  }
  return subscription.interval;
}

function isSameProvisioningIntent(
  provider: RazorpaySubscription,
  input: {
    organizationId: string;
    changeId: string;
    sourceProviderSubscriptionId: string;
    providerMode: string;
    providerPlanId: string;
    quantity: number;
    startAt: number;
    expireBy: number;
  }
) {
  return provider.notes?.organization_id === input.organizationId
    && provider.notes?.billing_change_id === input.changeId
    && provider.notes?.replacement_source_subscription_id === input.sourceProviderSubscriptionId
    && provider.notes?.provider_mode === input.providerMode
    && provider.notes?.billing_type === "saas_subscription_replacement"
    && provider.plan_id === input.providerPlanId
    && (provider.quantity ?? 1) === input.quantity
    && provider.start_at === input.startAt
    && provider.expire_by === input.expireBy;
}

async function releaseLease(
  tx: Prisma.TransactionClient,
  organizationId: string,
  leaseToken: string
) {
  await tx.organization.updateMany({
    where: { id: organizationId, billingMutationLeaseToken: leaseToken },
    data: { billingMutationLeaseToken: null, billingMutationLeaseUntil: null },
  });
}

async function finalizeCandidateCancellation(
  tx: Prisma.TransactionClient,
  input: {
    change: ReplacementCancellationChange;
    provider: RazorpaySubscription;
    intent: CandidateCancellationIntent;
    now: Date;
    expectedWhere: Prisma.OrganizationBillingChangeWhereInput;
  }
) {
  const change = input.change;
  const candidate = change.replacementSubscription;
  if (!candidate) throw new Error("Replacement candidate disappeared during cancellation finalization");
  assertTerminalCandidateCancellationResponse(input.provider, candidate);

  const candidateReleased = await tx.organizationSubscription.updateMany({
    where: {
      id: candidate.id,
      pendingReplacementOrganizationId: change.organizationId,
      razorpaySubscriptionId: candidate.razorpaySubscriptionId,
    },
    data: {
      pendingReplacementOrganizationId: null,
      status: mapProviderStatus(input.provider.status),
      cancelledAt: candidate.cancelledAt ?? input.now,
      endedAt: dateFromTimestamp(input.provider.ended_at) ?? candidate.endedAt ?? input.now,
      lastReconciledAt: input.now,
    },
  });
  if (candidateReleased.count !== 1) {
    throw new Error("Replacement candidate slot changed during cancellation finalization");
  }

  const undoRequested = input.intent !== "FAILURE";
  const sourceCancellationCommitted = Boolean(
    change.organizationSubscription?.cancelAtCycleEnd
    || change.organizationSubscription?.cancellationScheduledAt
  );
  const failureEvent = ["ABANDONED", "DECLINED", "FAILED"].includes(change.operationStatus)
    ? change.operationStatus
    : "FAILED";
  const operationStatus = undoRequested ? "ABANDONED" : failureEvent;
  const terminalStatus = undoRequested || operationStatus === "ABANDONED" ? "UNDONE" : "FAILED";
  const sourceStillRequiresReview = !undoRequested && sourceCancellationCommitted;

  if (undoRequested && change.branchId) {
    if (change.type === "BRANCH_REMOVAL") {
      await tx.branch.updateMany({
        where: { id: change.branchId, organizationId: change.organizationId },
        data: {
          billingStatus: "ACTIVE",
          billingArchivedAt: null,
        },
      });
    } else if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE", "BRANCH_REACTIVATION"]
      .includes(change.type)) {
      await tx.branch.updateMany({
        where: { id: change.branchId, organizationId: change.organizationId },
        data: input.intent === "UNDO_ARCHIVE"
          ? {
              billingStatus: "ARCHIVED",
              billingActivatedAt: null,
              billingArchivedAt: input.now,
            }
          : change.type === "BRANCH_REACTIVATION"
            ? { billingStatus: "ARCHIVED", billingArchivedAt: input.now }
            : { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
      });
    }
  }

  const finalized = await tx.organizationBillingChange.updateMany({
    where: { id: change.id, ...input.expectedWhere },
    data: {
      status: terminalStatus,
      operationStatus,
      failureCategory: undoRequested
        ? null
        : sourceStillRequiresReview
          ? "MANUAL_REVIEW_REQUIRED"
          : operationStatus === "ABANDONED"
            ? "CHECKOUT_ABANDONED"
            : "PROVIDER_AUTHORIZATION_FAILED",
      failureCode: sourceStillRequiresReview ? "SOURCE_CANCELLATION_REQUIRES_REVIEW" : null,
      lastError: undoRequested
        ? null
        : sourceStillRequiresReview
          ? "The replacement candidate is cancelled, but source cancellation still requires manual recovery"
          : change.lastError,
      failedAt: terminalStatus === "FAILED" ? (change.failedAt ?? input.now) : null,
      abandonedAt: terminalStatus === "UNDONE" ? (change.abandonedAt ?? input.now) : change.abandonedAt,
      undoneAt: terminalStatus === "UNDONE" ? (change.undoneAt ?? input.now) : change.undoneAt,
      resolvedAt: sourceStillRequiresReview ? null : input.now,
      accessRevokedAt: change.accessGrantedAt ? (change.accessRevokedAt ?? input.now) : change.accessRevokedAt,
      processingStartedAt: null,
    },
  });
  if (finalized.count !== 1) {
    throw new Error("Replacement cancellation attempt changed before finalization");
  }
  if (change.failureCategory === "MANUAL_REVIEW_REQUIRED"
    || isCandidateCancellationReconciliationCode(change.failureCode)) {
    await recordBillingMutationAudit(tx, {
      changeId: change.id,
      organizationId: change.organizationId,
      organizationSubscriptionId: change.organizationSubscriptionId,
      attemptCount: change.attemptCount,
      outcome: "PROVIDER_STATE_ADOPTED",
    });
  }
  return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
}

async function finalizeRejectedCandidateCancellationAttempt(
  input: {
    change: OrganizationBillingChange;
    leaseToken: string;
    processingCode: string;
    rejectedCode: string;
    error: unknown;
    now: Date;
  }
) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization" WHERE "id" = ${input.change.organizationId} FOR UPDATE
    `;
    const organization = await tx.organization.findUnique({
      where: { id: input.change.organizationId },
      select: { billingMutationLeaseToken: true },
    });
    if (organization?.billingMutationLeaseToken !== input.leaseToken) {
      return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: input.change.id } });
    }
    await tx.organizationBillingChange.updateMany({
      where: {
        id: input.change.id,
        status: "PROCESSING",
        attemptCount: input.change.attemptCount,
        processingStartedAt: input.change.processingStartedAt,
        failureCode: input.processingCode,
      },
      data: {
        status: "FAILED",
        failureCategory: "PROVIDER_REJECTED",
        failureCode: input.rejectedCode,
        lastError: cancellationErrorMessage(input.error),
        failedAt: input.now,
        resolvedAt: input.now,
      },
    });
    await releaseLease(tx, input.change.organizationId, input.leaseToken);
    return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: input.change.id } });
  });
}

async function quarantineCandidateCancellationAttempt(
  input: {
    change: OrganizationBillingChange;
    leaseToken: string;
    processingCode: string;
    outcomeUnknownCode: string;
    error: unknown;
    now: Date;
  }
) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization" WHERE "id" = ${input.change.organizationId} FOR UPDATE
    `;
    const organization = await tx.organization.findUnique({
      where: { id: input.change.organizationId },
      select: { billingMutationLeaseToken: true },
    });
    if (organization?.billingMutationLeaseToken !== input.leaseToken) {
      return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: input.change.id } });
    }
    const quarantined = await tx.organizationBillingChange.updateMany({
      where: {
        id: input.change.id,
        status: "PROCESSING",
        attemptCount: input.change.attemptCount,
        processingStartedAt: input.change.processingStartedAt,
        failureCode: input.processingCode,
      },
      data: {
        status: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: input.outcomeUnknownCode,
        lastError: `Replacement cancellation outcome is unknown: ${cancellationErrorMessage(input.error)}`,
        failedAt: input.now,
        resolvedAt: null,
      },
    });
    if (quarantined.count === 1) {
      await recordBillingMutationAudit(tx, {
        changeId: input.change.id,
        organizationId: input.change.organizationId,
        organizationSubscriptionId: input.change.organizationSubscriptionId,
        attemptCount: input.change.attemptCount,
        outcome: "MANUAL_REVIEW_REQUIRED",
        failureCode: input.outcomeUnknownCode,
      });
    }
    await releaseLease(tx, input.change.organizationId, input.leaseToken);
    return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: input.change.id } });
  });
}

export class BillingReplacementService {
  static async assertNoOpenReplacement(
    tx: Prisma.TransactionClient,
    organizationId: string,
    allowedChangeId?: string
  ) {
    const existing = await tx.organizationBillingChange.findFirst({
      where: {
        organizationId,
        status: { in: [...OPEN_CHANGE_STATUSES] },
        type: {
          in: [
            "PAYMENT_METHOD_REPLACEMENT",
            "TRIAL_SUBSCRIPTION_UPDATE",
            "PLAN_UPGRADE",
            "PLAN_DOWNGRADE",
            "QUANTITY_INCREASE",
            "BRANCH_REMOVAL",
            "BRANCH_REACTIVATION",
          ],
        },
        OR: [
          { replacementSubscriptionId: { not: null } },
          { organizationSubscription: { providerPaymentMethod: { in: ["UPI", "EMANDATE"] } } },
          { type: "PAYMENT_METHOD_REPLACEMENT" },
        ],
        ...(allowedChangeId ? { id: { not: allowedChangeId } } : {}),
      },
      orderBy: { sequence: "asc" },
    });
    if (existing) throw new BillingChangeInProgressError(existing.id);

    const pending = await tx.organizationSubscription.findUnique({
      where: { pendingReplacementOrganizationId: organizationId },
      select: { replacementBillingChange: { select: { id: true } } },
    });
    const pendingChangeId = pending?.replacementBillingChange?.id;
    if (pending && pendingChangeId !== allowedChangeId) {
      throw new BillingChangeInProgressError(pendingChangeId ?? "pending-replacement");
    }
  }

  /**
   * Provisions (or adopts) the provider candidate for a mutation already
   * claimed under BillingMutationService's organization lease.
   */
  static async provisionClaimedChange(
    changeId: string,
    leaseToken: string,
    now = new Date()
  ) {
    let change = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      include: {
        organizationSubscription: { include: { billingOffer: true } },
        replacementSubscription: true,
      },
    }) as ReplacementWithSource | null;
    if (!change || change.status !== "PROCESSING") {
      throw new Error("Claimed replacement billing change not found");
    }
    const organizationId = change.organizationId;
    const source = change.organizationSubscription;
    if (!source || source.currentOrganizationId !== change.organizationId) {
      throw new Error("Replacement source is no longer the current subscription");
    }
    if (!isReplacementMutationEligible({
      sourcePaymentMethod: source.providerPaymentMethod,
      mutationType: change.type,
    })) {
      throw new Error("This billing change does not require subscription replacement");
    }
    if (change.replacementSubscription) {
      await prisma.$transaction(tx => releaseLease(tx, organizationId, leaseToken));
      return { change, subscription: change.replacementSubscription, adopted: true };
    }

    assertRazorpayBillingWritesEnabled(change.organizationId);
    const providerMode = resolveRazorpayMode();
    if (source.providerMode !== providerMode) {
      throw new Error(`Subscription provider mode ${source.providerMode} cannot be replaced in ${providerMode} mode`);
    }
    const intendedPlan = change.toPlan ?? source.plan;
    const intendedQuantity = change.toQuantity ?? source.quantity;
    if (!Number.isInteger(intendedQuantity) || intendedQuantity < 1) {
      throw new Error("A replacement subscription must retain at least one billable branch");
    }
    let commercialIntent;
    if (change.commercialIntentVersion != null) {
      commercialIntent = readCommercialIntentSnapshot(change);
      if (commercialIntent.authorizedProviderMode !== providerMode
        || commercialIntent.authorizedSourceRazorpaySubscriptionId
          !== source.razorpaySubscriptionId
        || commercialIntent.authorizedSourceRazorpayPlanId !== source.razorpayPlanId
        || commercialIntent.authorizedPlan !== intendedPlan
        || commercialIntent.authorizedQuantity !== intendedQuantity
        || commercialIntent.authorizedRazorpayOfferId != null) {
        throw new Error("The immutable commercial authorization does not match this replacement");
      }
    } else {
      const targetPlan = getBillingPlan(intendedPlan);
      if (!targetPlan?.amount) {
        throw new Error("Target billing plan is not available for replacement");
      }
      const mapping = await ensureRazorpayPlanCatalogEntry({
        plan: targetPlan.id,
        name: targetPlan.name,
        description: targetPlan.description,
        amount: targetPlan.amount,
        currency: targetPlan.currency,
        period: targetPlan.period,
        interval: targetPlan.interval,
      });
      if (mapping.providerMode !== providerMode) {
        throw new Error("Razorpay plan mapping belongs to the wrong provider mode");
      }
      commercialIntent = buildCommercialIntentSnapshot({
        providerMode,
        sourceRazorpaySubscriptionId: source.razorpaySubscriptionId,
        razorpaySubscriptionId: null,
        sourceRazorpayPlanId: source.razorpayPlanId,
        razorpayPlanId: mapping.razorpayPlanId,
        plan: mapping.plan,
        quantity: intendedQuantity,
        unitAmountSubunits: mapping.amountSubunits,
        currency: mapping.currency,
        period: mapping.period,
        interval: mapping.interval,
        offer: null,
        capturedAt: now,
      });
      change = await captureProcessingCommercialIntent({
        change,
        leaseToken,
        intent: commercialIntent,
      }) as ReplacementWithSource;
    }
    const targetPlanId = commercialIntent.authorizedPlan;
    const targetQuantity = commercialIntent.authorizedQuantity;
    const targetProviderPlanId = commercialIntent.authorizedRazorpayPlanId;
    const targetAmountSubunits = commercialIntent.authorizedUnitAmountSubunits;
    const targetCurrency = commercialIntent.authorizedCurrency;
    const targetPeriod = commercialIntent.authorizedPeriod;
    const targetInterval = commercialIntent.authorizedInterval;
    const targetAmount = fromRazorpaySubunits(targetAmountSubunits, targetCurrency);

    const razorpay = getRazorpayClient();
    const providerSource = await razorpay.fetchSubscription(source.razorpaySubscriptionId);
    if (providerSource.id !== source.razorpaySubscriptionId) {
      throw new Error("Razorpay source subscription mismatch during replacement");
    }
    const providerBoundary = dateFromTimestamp(providerSource.current_end);
    const futureStartBoundary = dateFromTimestamp(providerSource.start_at) ?? source.providerStartAt;
    const currentBoundary = providerBoundary
      ?? source.currentEnd
      ?? source.paidThrough
      ?? futureStartBoundary;
    if (!currentBoundary) throw new Error("A current billing-cycle boundary is required for replacement");

    const cadenceMonths = intervalMonths(source);
    let discountSafeBoundary = currentBoundary;
    if (source.billingOffer?.durationType === "LIMITED_CYCLES") {
      const confirmedRenewals = Math.max(providerSource.paid_count ?? 0, 0);
      const discountedRenewalsRemaining = Math.max(
        source.billingOffer.durationCycles - confirmedRenewals,
        0
      );
      if (discountedRenewalsRemaining > 1) {
        discountSafeBoundary = addCalendarMonthsUtc(
          currentBoundary,
          discountedRenewalsRemaining * cadenceMonths
        );
      } else if (discountedRenewalsRemaining === 1) {
        discountSafeBoundary = addCalendarMonthsUtc(currentBoundary, cadenceMonths);
      }
    }
    const effectiveAt = getSafeReplacementCycleBoundary({
      now,
      currentCycleEnd: discountSafeBoundary,
      intervalMonths: cadenceMonths,
    });
    const undoCutoffAt = getReplacementUndoCutoffAt(effectiveAt);
    const accessGraceEndsAt = getReplacementChargeGraceEndsAt(effectiveAt);
    const providerIntent = {
      organizationId: change.organizationId,
      changeId: change.id,
      sourceProviderSubscriptionId: source.razorpaySubscriptionId,
      providerMode,
      providerPlanId: targetProviderPlanId,
      quantity: targetQuantity,
      startAt: timestamp(effectiveAt),
      expireBy: timestamp(undoCutoffAt),
    };

    let providerCandidate: RazorpaySubscription | null = null;
    let adopted = false;
    if (razorpay.listSubscriptions) {
      const matches: RazorpaySubscription[] = [];
      for (let skip = 0; ; skip += 100) {
        const page = await razorpay.listSubscriptions({ count: 100, skip });
        matches.push(...page.items.filter(candidate => isSameProvisioningIntent(candidate, providerIntent)));
        if (page.items.length < 100) break;
      }
      const liveMatches = matches
        .filter(candidate => isSameProvisioningIntent(candidate, providerIntent))
        .filter(candidate => !TERMINAL_PROVIDER_STATUSES.has(candidate.status.toLowerCase()))
        .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0));
      const ambiguousMatches = liveMatches.filter(candidate =>
        candidate.status.toLowerCase() !== "created"
        || (candidate.paid_count ?? 0) > 0
      );
      if (ambiguousMatches.length > 0) {
        await prisma.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            lastError: "An authorized or charged Razorpay replacement candidate requires manual review",
          },
        });
        throw new Error("A live replacement subscription requires manual review");
      }
      providerCandidate = liveMatches[0] ?? null;
      adopted = providerCandidate != null;
      for (const duplicate of liveMatches.slice(1)) {
        await razorpay.cancelSubscription(duplicate.id, { cancel_at_cycle_end: false });
      }
    }

    if (!providerCandidate) {
      providerCandidate = await razorpay.createSubscription({
        plan_id: targetProviderPlanId,
        total_count: Math.max(providerSource.remaining_count ?? getDefaultSubscriptionCycles(), 1),
        quantity: targetQuantity,
        customer_notify: true,
        start_at: providerIntent.startAt,
        expire_by: providerIntent.expireBy,
        notes: {
          app: "lab_lords",
          billing_type: "saas_subscription_replacement",
          organization_id: change.organizationId,
          provider_mode: providerMode,
          billing_change_id: change.id,
          replacement_source_subscription_id: source.razorpaySubscriptionId,
          plan: targetPlanId,
        },
      });
    }
    if (!isSameProvisioningIntent(providerCandidate, providerIntent)) {
      throw new Error("Razorpay replacement does not match the expected plan and branch quantity");
    }

    const stored = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
        `;
        const leaseOwner = await tx.organization.findFirst({
          where: { id: change.organizationId, billingMutationLeaseToken: leaseToken },
          select: { id: true },
        });
        if (!leaseOwner) throw new Error("Billing mutation lease was lost while saving replacement");
        await this.assertNoOpenReplacement(tx, change.organizationId, change.id);

        const current = await tx.organizationSubscription.findUnique({
          where: { currentOrganizationId: change.organizationId },
        });
        if (current?.id !== source.id || current.razorpaySubscriptionId !== source.razorpaySubscriptionId) {
          throw new Error("Current subscription changed while replacement was being created");
        }
        const latestChange = await tx.organizationBillingChange.findUnique({ where: { id: change.id } });
        if (!latestChange || latestChange.status !== "PROCESSING" || latestChange.replacementSubscriptionId) {
          throw new Error("Replacement billing change changed while provider subscription was being created");
        }
        if (latestChange.attemptCount !== change.attemptCount
          || latestChange.processingStartedAt?.getTime() !== change.processingStartedAt?.getTime()) {
          throw new Error("Replacement billing attempt changed while provider subscription was being created");
        }
        if (latestChange.authorizedRazorpaySubscriptionId != null
          && latestChange.authorizedRazorpaySubscriptionId !== providerCandidate!.id) {
          throw new Error("Replacement provider identity conflicts with the commercial authorization");
        }
        if (latestChange.authorizedRazorpaySubscriptionId == null) {
          const bound = await tx.organizationBillingChange.updateMany({
            where: {
              id: change.id,
              status: "PROCESSING",
              attemptCount: change.attemptCount,
              processingStartedAt: change.processingStartedAt,
              authorizedRazorpaySubscriptionId: null,
            },
            data: { authorizedRazorpaySubscriptionId: providerCandidate!.id },
          });
          if (bound.count !== 1) {
            throw new Error("Replacement provider identity could not be bound to this attempt");
          }
        }

        const candidate = await tx.organizationSubscription.create({
          data: {
            organizationId: change.organizationId,
            pendingReplacementOrganizationId: change.organizationId,
            replacesSubscriptionId: source.id,
            providerMode,
            plan: targetPlanId,
            amount: targetAmount,
            amountSubunits: targetAmountSubunits,
            currency: targetCurrency,
            period: targetPeriod,
            interval: targetInterval,
            totalCount: providerCandidate!.total_count,
            quantity: targetQuantity,
            razorpayPlanId: targetProviderPlanId,
            razorpaySubscriptionId: providerCandidate!.id,
            razorpayCustomerId: providerCandidate!.customer_id ?? null,
            status: mapProviderStatus(providerCandidate!.status),
            providerStartAt: dateFromTimestamp(providerCandidate!.start_at) ?? effectiveAt,
            authorizationExpiresAt: dateFromTimestamp(providerCandidate!.expire_by) ?? undoCutoffAt,
            providerPaymentMethod: normalizeProviderPaymentMethod(providerCandidate!.payment_method),
            currentStart: dateFromTimestamp(providerCandidate!.current_start),
            currentEnd: dateFromTimestamp(providerCandidate!.current_end),
            chargeAt: dateFromTimestamp(providerCandidate!.charge_at),
            endedAt: dateFromTimestamp(providerCandidate!.ended_at),
            createdByUserId: change.createdByUserId,
          },
        });
        const updatedChange = await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            replacementSubscriptionId: candidate.id,
            status: "AWAITING_PAYMENT",
            operationStatus: "CHECKOUT_OPEN",
            effectiveAt,
            undoCutoffAt,
            accessGraceEndsAt,
            confirmationDeadlineAt: undoCutoffAt,
            checkoutOpenedAt: now,
            processingStartedAt: null,
            lastError: null,
          },
        });
        await releaseLease(tx, change.organizationId, leaseToken);
        return { change: updatedChange, subscription: candidate };
    });
    return { ...stored, adopted };
  }

  /**
   * Applies or revokes the temporary access attached to an authorized
   * replacement. Call this after a server-side provider refresh of the
   * candidate; it never changes the current subscription slot or its billing
   * facts.
   */
  static async syncAuthorizedAccess(
    changeId: string,
    now = new Date(),
    options: SyncAuthorizedAccessOptions = {}
  ) {
    return prisma.$transaction(async tx => {
      const initial = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        select: { organizationId: true },
      });
      if (!initial) throw new Error("Replacement billing change not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: {
          organizationSubscription: true,
          replacementSubscription: true,
          branch: true,
        },
      });
      const source = change?.organizationSubscription;
      const candidate = change?.replacementSubscription;
      if (!change || !source || !candidate) {
        throw new Error("Replacement billing change not found");
      }

      let frozenIntent = null;
      try {
        frozenIntent = readCommercialIntentSnapshot(change, { requireBoundSubscription: true });
      } catch {
        // Missing or corrupt commercial evidence must never grant replacement access.
      }
      const exactIntentBound = Boolean(
        frozenIntent
        && candidate.confirmedCommercialIntentChangeId === change.id
        && frozenIntent.authorizedProviderMode === candidate.providerMode
        && frozenIntent.authorizedSourceRazorpaySubscriptionId
          === source.razorpaySubscriptionId
        && frozenIntent.authorizedRazorpaySubscriptionId
          === candidate.razorpaySubscriptionId
        && frozenIntent.authorizedPlan === candidate.plan
        && frozenIntent.authorizedQuantity === candidate.quantity
        && frozenIntent.authorizedRazorpayPlanId === candidate.razorpayPlanId
      );
      const targetPlan = frozenIntent?.authorizedPlan ?? source.plan;
      const targetQuantity = frozenIntent?.authorizedQuantity ?? source.quantity;
      const targetProviderPlanId = exactIntentBound
        ? frozenIntent!.authorizedRazorpayPlanId
        : null;
      const authorizationReady = exactIntentBound && isReplacementAuthorizationReady({
        providerStatus: candidate.status,
        paymentMethod: candidate.providerPaymentMethod,
        providerPlanId: candidate.razorpayPlanId,
        providerQuantity: candidate.quantity,
        targetPlanId: targetProviderPlanId ?? "",
        targetQuantity,
      });
      let decisionChange = change;
      const exactManualReviewResolution = authorizationReady
        && options.resolveManualReview === true
        && change.status === "FAILED"
        && change.operationStatus === "FAILED"
        && change.failureCategory === "MANUAL_REVIEW_REQUIRED";
      if (exactManualReviewResolution) {
        const resolved = await tx.organizationBillingChange.updateMany({
          where: {
            id: change.id,
            replacementSubscriptionId: candidate.id,
            status: "FAILED",
            operationStatus: "FAILED",
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            failureCode: change.failureCode,
            attemptCount: change.attemptCount,
            updatedAt: change.updatedAt,
          },
          data: {
            status: "SCHEDULED",
            operationStatus: "SCHEDULED",
            providerConfirmedAt: change.providerConfirmedAt ?? now,
            failureCategory: null,
            failureCode: null,
            lastError: null,
            failedAt: null,
            resolvedAt: null,
          },
        });
        if (resolved.count !== 1) {
          const latest = await tx.organizationBillingChange.findUniqueOrThrow({
            where: { id: change.id },
            include: {
              organizationSubscription: true,
              replacementSubscription: true,
              branch: true,
            },
          });
          return { action: "NONE" as const, change: latest, subscription: candidate };
        }
        await recordBillingMutationAudit(tx, {
          changeId: change.id,
          organizationId: change.organizationId,
          organizationSubscriptionId: change.organizationSubscriptionId,
          attemptCount: change.attemptCount,
          outcome: "PROVIDER_STATE_ADOPTED",
        });
        decisionChange = await tx.organizationBillingChange.findUniqueOrThrow({
          where: { id: change.id },
          include: {
            organizationSubscription: true,
            replacementSubscription: true,
            branch: true,
          },
        });
      } else if (authorizationReady
        && !["FAILED", "UNDONE", "SUPERSEDED", "APPLIED"].includes(change.status)
        && change.operationStatus !== "SCHEDULED") {
        decisionChange = await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            status: "SCHEDULED",
            operationStatus: "SCHEDULED",
            providerConfirmedAt: change.providerConfirmedAt ?? now,
            failureCategory: null,
            failureCode: null,
            lastError: null,
          },
          include: {
            organizationSubscription: true,
            replacementSubscription: true,
            branch: true,
          },
        });
      }
      const action = getReplacementAccessAction({
        changeType: decisionChange.type,
        changeStatus: decisionChange.status,
        failureCategory: decisionChange.failureCategory,
        sourcePlan: source.plan,
        sourceQuantity: source.quantity,
        targetPlan,
        targetQuantity,
        candidatePlan: candidate.plan,
        candidateQuantity: candidate.quantity,
        candidateStatus: candidate.status,
        candidatePaymentMethod: candidate.providerPaymentMethod,
        candidateProviderPlanId: candidate.razorpayPlanId,
        targetProviderPlanId,
        accessGrantedAt: decisionChange.accessGrantedAt,
        accessRevokedAt: decisionChange.accessRevokedAt,
        effectiveAt: decisionChange.effectiveAt,
        accessGraceEndsAt: decisionChange.accessGraceEndsAt,
        now,
      });

      if (action === "NONE") return { action, change: decisionChange, subscription: candidate };

      if (action === "GRANT") {
        if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE", "BRANCH_REACTIVATION"].includes(change.type)
          && (!change.branch || change.branch.billingStatus !== "PENDING_ACTIVATION")) {
          return { action: "NONE" as const, change, subscription: candidate };
        }
        const granted = await tx.organizationBillingChange.updateMany({
          where: { id: change.id, accessGrantedAt: null, accessRevokedAt: null },
          data: { accessGrantedAt: now },
        });
        if (granted.count === 0) {
          const latest = await tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
          return { action: "NONE" as const, change: latest, subscription: candidate };
        }
        if (change.branch && ["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "ACTIVE", billingActivatedAt: now, billingArchivedAt: null },
          });
        }
        if (change.branch && change.type === "BRANCH_REACTIVATION") {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: {
              billingStatus: "ACTIVE",
              billingActivatedAt: now,
              billingArchivedAt: null,
            },
          });
        }
        const updated = await tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
        return { action, change: updated, subscription: candidate };
      }

      const revoked = await tx.organizationBillingChange.updateMany({
        where: { id: change.id, accessGrantedAt: { not: null }, accessRevokedAt: null },
        data: { accessRevokedAt: now },
      });
      if (revoked.count > 0 && change.branch?.billingStatus === "ACTIVE") {
        if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
          });
        }
        if (change.type === "BRANCH_REACTIVATION") {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
          });
        }
      }
      const updated = await tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
      return { action, change: updated, subscription: candidate };
    });
  }

  /** Terminalizes Checkout and gives candidate cancellation one fenced attempt. */
  static async failReplacementCheckout(
    changeId: string,
    event: "ABANDONED" | "DECLINED" | "FAILED",
    now = new Date(),
    reason?: string,
    options: { expectedFailureCode?: string } = {}
  ) {
    const snapshot = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      select: { organizationId: true },
    });
    if (!snapshot) throw new Error("Replacement billing change not found");
    assertRazorpayBillingWritesEnabled(snapshot.organizationId);
    const razorpay = getRazorpayClient();
    const leaseToken = crypto.randomUUID();
    const claimed = await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: snapshot.organizationId },
        select: { billingMutationLeaseToken: true, billingMutationLeaseUntil: true },
      });
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: {
          organizationSubscription: true,
          replacementSubscription: true,
          branch: true,
        },
      });
      const candidate = change?.replacementSubscription;
      if (!change || !candidate) throw new Error("Replacement billing change not found");
      if (options.expectedFailureCode && change.failureCode !== options.expectedFailureCode) {
        throw new BillingChangeInProgressError(
          change.id,
          "Replacement cancellation state changed before its safe retry"
        );
      }
      const retryIntent = candidateCancellationRetryIntent(change.failureCode);
      if (retryIntent && retryIntent !== "FAILURE") {
        throw new BillingChangeInProgressError(
          change.id,
          "Replacement undo cancellation must retain its original branch disposition"
        );
      }
      if (change.operationStatus === "APPLIED") {
        return { change, candidate, cancelCandidate: false };
      }
      if (change.status === "PROCESSING") {
        throw new BillingChangeInProgressError(change.id, "Replacement candidate cancellation is processing");
      }
      if (change.failureCategory === "MANUAL_REVIEW_REQUIRED"
        || isCandidateCancellationReconciliationCode(change.failureCode)) {
        throw new BillingManualReviewRequiredError(
          change.id,
          "Replacement candidate cancellation must be reconciled before any later mutation"
        );
      }

      const terminalStatus = event === "ABANDONED" ? "UNDONE" as const : "FAILED" as const;
      const alreadyTerminal = ["FAILED", "UNDONE", "SUPERSEDED"].includes(change.status);
      const revokeAccess = Boolean(change.accessGrantedAt && !change.accessRevokedAt);
      const candidateAlreadyArchived = candidate.pendingReplacementOrganizationId == null;
      const candidateAlreadyTerminal = TERMINAL_PROVIDER_STATUSES.has(candidate.status.toLowerCase());
      const cancellationPending = !candidateAlreadyArchived && !candidateAlreadyTerminal;
      const sourceCancellationCommitted = Boolean(
        change.organizationSubscription?.cancelAtCycleEnd
        || change.organizationSubscription?.cancellationScheduledAt
      );
      if (cancellationPending && (organization.billingMutationLeaseToken
        || (organization.billingMutationLeaseUntil && organization.billingMutationLeaseUntil > now))) {
        throw new BillingChangeInProgressError(change.id, "Another billing operation is still processing");
      }
      const failureCategory = sourceCancellationCommitted
        ? "MANUAL_REVIEW_REQUIRED" as const
        : event === "ABANDONED"
          ? "CHECKOUT_ABANDONED" as const
          : "PROVIDER_AUTHORIZATION_FAILED" as const;
      const lastError = sourceCancellationCommitted
        ? "The replacement failed after source cancellation was scheduled; manual recovery is required"
        : reason ?? (event === "ABANDONED"
          ? "Replacement checkout was closed before mandate authorization"
          : "Replacement mandate authorization failed");
      const processingStartedAt = cancellationPending ? now : null;
      const attemptCount = cancellationPending ? change.attemptCount + 1 : change.attemptCount;
      await tx.organizationBillingChange.update({
        where: { id: change.id },
        data: {
          status: cancellationPending ? "PROCESSING" : terminalStatus,
          operationStatus: event,
          failureCategory,
          failureCode: cancellationPending ? CANDIDATE_CANCELLATION_PROCESSING_CODE : null,
          lastError,
          abandonedAt: event === "ABANDONED" ? (change.abandonedAt ?? now) : undefined,
          undoneAt: !cancellationPending && event === "ABANDONED" ? (change.undoneAt ?? now) : undefined,
          declinedAt: event === "DECLINED" ? (change.declinedAt ?? now) : undefined,
          failedAt: event === "ABANDONED" ? undefined : (change.failedAt ?? now),
          resolvedAt: cancellationPending || sourceCancellationCommitted ? null : now,
          accessRevokedAt: revokeAccess ? now : undefined,
          attemptCount,
          processingStartedAt,
        },
      });
      if (revokeAccess && change.branch?.billingStatus === "ACTIVE") {
        if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
          });
        }
        if (change.type === "BRANCH_REACTIVATION") {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
          });
        }
      }
      let updated = alreadyTerminal && !revokeAccess
        && !cancellationPending
          ? change
          : await tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
      if (!candidateAlreadyArchived && candidateAlreadyTerminal) {
        await tx.organizationSubscription.update({
          where: { id: candidate.id },
          data: {
            pendingReplacementOrganizationId: null,
            cancelledAt: candidate.cancelledAt ?? now,
            endedAt: candidate.endedAt ?? now,
          },
        });
        updated = await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: { failureCode: null, processingStartedAt: null },
        });
      }
      if (cancellationPending) {
        await tx.organization.update({
          where: { id: change.organizationId },
          data: {
            billingMutationLeaseToken: leaseToken,
            billingMutationLeaseUntil: new Date(now.getTime() + REPLACEMENT_PROVIDER_LEASE_MS),
          },
        });
      }
      return {
        change: updated,
        candidate,
        cancelCandidate: !candidateAlreadyArchived && !candidateAlreadyTerminal,
      };
    });

    if (!claimed.cancelCandidate) return claimed.change;
    const processingCode = CANDIDATE_CANCELLATION_PROCESSING_CODE;
    try {
      const cancelled = await razorpay.cancelSubscription(
        claimed.candidate.razorpaySubscriptionId,
        { cancel_at_cycle_end: false }
      );
      assertTerminalCandidateCancellationResponse(cancelled, claimed.candidate);
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${claimed.change.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: claimed.change.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (organization.billingMutationLeaseToken !== leaseToken) {
          throw new Error("Replacement cancellation lease was lost before finalization");
        }
        const latest = await tx.organizationBillingChange.findUnique({
          where: { id: changeId },
          include: { organizationSubscription: true, replacementSubscription: true },
        }) as ReplacementCancellationChange | null;
        if (!latest?.replacementSubscription
          || latest.replacementSubscription.id !== claimed.candidate.id) {
          throw new Error("Replacement changed before candidate cancellation finalized");
        }
        const finalized = await finalizeCandidateCancellation(tx, {
          change: latest,
          provider: cancelled,
          intent: "FAILURE",
          now,
          expectedWhere: {
            status: "PROCESSING",
            attemptCount: claimed.change.attemptCount,
            processingStartedAt: claimed.change.processingStartedAt,
            failureCode: processingCode,
          },
        });
        await releaseLease(tx, claimed.change.organizationId, leaseToken);
        return finalized;
      });
    } catch (error) {
      if (isDefinitelyRejectedProviderError(error)) {
        await finalizeRejectedCandidateCancellationAttempt({
          change: claimed.change,
          leaseToken,
          processingCode,
          rejectedCode: CANDIDATE_CANCELLATION_PROVIDER_REJECTED_CODE,
          error,
          now,
        });
        throw error;
      }
      const quarantined = await quarantineCandidateCancellationAttempt({
        change: claimed.change,
        leaseToken,
        processingCode,
        outcomeUnknownCode: CANDIDATE_CANCELLATION_OUTCOME_UNKNOWN_CODE,
        error,
        now,
      });
      if (quarantined.failureCategory === "MANUAL_REVIEW_REQUIRED") {
        throw new BillingManualReviewRequiredError(quarantined.id);
      }
      throw error;
    }
  }

  static async scheduleSourceCancellation(changeId: string, now = new Date()) {
    const snapshot = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      include: { organizationSubscription: true },
    });
    if (!snapshot?.organizationSubscription) {
      throw new Error("Replacement source subscription not found");
    }
    // The source boundary may have advanced since the candidate was created.
    // Fetch provider truth immediately before the cancellation decision.
    await BillingReconciliationService.reconcileProviderSubscription(
      snapshot.organizationSubscription.razorpaySubscriptionId,
      { now }
    );

    const leaseToken = crypto.randomUUID();
    const claim = await prisma.$transaction(async tx => {
      const initial = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        select: { organizationId: true },
      });
      if (!initial) throw new Error("Replacement billing change not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: initial.organizationId },
        select: { billingMutationLeaseToken: true },
      });
      if (organization.billingMutationLeaseToken) {
        throw new Error("Another billing operation is still processing; retry shortly");
      }
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: { organizationSubscription: true, replacementSubscription: true },
      });
      const source = change?.organizationSubscription;
      const candidate = change?.replacementSubscription;
      if (!change || !source || !candidate) throw new Error("Replacement billing change not found");
      if (["FAILED", "UNDONE", "SUPERSEDED"].includes(change.status) || change.accessRevokedAt) {
        return { skipped: "REPLACEMENT_TERMINAL" as const };
      }
      if (["CANCELLED", "COMPLETED", "EXPIRED"].includes(source.status)) {
        return { skipped: "SOURCE_ALREADY_ENDED" as const };
      }
      if (source.cancelAtCycleEnd
        && source.cancellationScheduledAt
        && change.effectiveAt
        && source.cancellationScheduledAt.getTime() === change.effectiveAt.getTime()) {
        return { skipped: "ALREADY_SCHEDULED" as const };
      }
      if (!change.undoCutoffAt || now < change.undoCutoffAt) {
        return { skipped: "UNDO_WINDOW_OPEN" as const };
      }
      if (!change.effectiveAt) throw new Error("Replacement effective date is missing");
      if (now >= change.effectiveAt) {
        const revokeAccess = Boolean(change.accessGrantedAt && !change.accessRevokedAt);
        await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            status: "FAILED",
            operationStatus: "FAILED",
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            lastError: "Source cancellation was not submitted before the replacement effective date",
            failedAt: now,
            accessRevokedAt: revokeAccess ? now : undefined,
          },
        });
        if (revokeAccess && change.branchId) {
          if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
            await tx.branch.updateMany({
              where: { id: change.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
            });
          }
          if (change.type === "BRANCH_REACTIVATION") {
            await tx.branch.updateMany({
              where: { id: change.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
            });
          }
        }
        return { skipped: "MANUAL_REVIEW_REQUIRED" as const };
      }
      const targetPlan = change.toPlan ?? source.plan;
      const targetQuantity = change.toQuantity ?? source.quantity;
      if (candidate.plan !== targetPlan || !isReplacementAuthorizationReady({
        providerStatus: candidate.status,
        paymentMethod: candidate.providerPaymentMethod,
        providerPlanId: candidate.razorpayPlanId,
        providerQuantity: candidate.quantity,
        targetPlanId: candidate.razorpayPlanId,
        targetQuantity,
      })) throw new BillingReplacementNotReadyError();
      if (!source.currentEnd || source.currentEnd.getTime() !== change.effectiveAt.getTime()) {
        return { skipped: "SOURCE_BOUNDARY_NOT_REACHED" as const };
      }
      if (source.currentOrganizationId !== change.organizationId
        || candidate.pendingReplacementOrganizationId !== change.organizationId) {
        throw new Error("Replacement slots changed before source cancellation");
      }
      await tx.organization.update({
        where: { id: change.organizationId },
        data: {
          billingMutationLeaseToken: leaseToken,
          billingMutationLeaseUntil: new Date(now.getTime() + REPLACEMENT_PROVIDER_LEASE_MS),
        },
      });
      return { skipped: null, change, source, candidate };
    });
    if (claim.skipped) {
      return {
        scheduled: ["SOURCE_ALREADY_ENDED", "ALREADY_SCHEDULED"].includes(claim.skipped),
        reason: claim.skipped,
      };
    }

    assertRazorpayBillingWritesEnabled(claim.change.organizationId);
    try {
      const provider = await getRazorpayClient().cancelSubscription(
        claim.source.razorpaySubscriptionId,
        { cancel_at_cycle_end: true }
      );
      if (provider.id !== claim.source.razorpaySubscriptionId) {
        throw new Error("Razorpay source mismatch while scheduling replacement cutover");
      }
      const providerStatus = provider.status.toLowerCase();
      const providerScheduledAt = dateFromTimestamp(provider.change_scheduled_at);
      const providerEnded = TERMINAL_PROVIDER_STATUSES.has(providerStatus);
      if (!providerEnded && (
        provider.has_scheduled_changes !== true
        || !providerScheduledAt
        || providerScheduledAt.getTime() !== claim.change.effectiveAt!.getTime()
      )) {
        throw new Error("Razorpay did not confirm the expected cycle-end source cancellation");
      }
      await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${claim.change.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: claim.change.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (organization.billingMutationLeaseToken !== leaseToken) {
          throw new Error("Billing mutation lease was lost during replacement cutover");
        }
        const latest = await tx.organizationBillingChange.findUnique({
          where: { id: changeId },
          include: { organizationSubscription: true, replacementSubscription: true },
        });
        if (!latest?.organizationSubscription || !latest.replacementSubscription
          || latest.organizationSubscription.id !== claim.source.id
          || latest.replacementSubscription.id !== claim.candidate.id
          || latest.status === "APPLIED") {
          throw new Error("Replacement changed during source cancellation");
        }
        await tx.organizationSubscription.update({
          where: { id: claim.source.id },
          data: {
            cancelAtCycleEnd: true,
            cancellationRequestedAt: now,
            cancellationScheduledAt: providerScheduledAt ?? claim.change.effectiveAt,
            lastReconciledAt: now,
          },
        });
        await tx.organizationBillingChange.update({
          where: { id: claim.change.id },
          data: { status: "SCHEDULED", operationStatus: "SCHEDULED", providerConfirmedAt: now },
        });
        await releaseLease(tx, claim.change.organizationId, leaseToken);
      });
      return { scheduled: true, reason: null };
    } catch (error) {
      await prisma.$transaction(async tx => {
        await tx.organizationBillingChange.updateMany({
          where: { id: claim.change.id, status: { not: "APPLIED" } },
          data: { lastError: error instanceof Error ? error.message : "Source cancellation failed" },
        });
        await releaseLease(tx, claim.change.organizationId, leaseToken);
      });
      throw error;
    }
  }

  static async promoteIfReady(changeId: string, now = new Date()) {
    return prisma.$transaction(async tx => {
      const initial = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        select: { organizationId: true },
      });
      if (!initial) throw new Error("Replacement billing change not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: { organizationSubscription: true, replacementSubscription: true },
      });
      const source = change?.organizationSubscription;
      const candidate = change?.replacementSubscription;
      if (!change || !source || !candidate) throw new Error("Replacement billing change not found");
      if (change.status === "APPLIED") return { promoted: true, change, subscription: candidate };
      if (["FAILED", "UNDONE", "SUPERSEDED"].includes(change.status)) {
        return { promoted: false, manualReview: false, change, subscription: candidate };
      }
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: change.organizationId },
        select: { billingMutationLeaseToken: true },
      });
      if (organization.billingMutationLeaseToken) {
        return {
          promoted: false,
          manualReview: false,
          deferredByLease: true,
          change,
          subscription: candidate,
        };
      }

      const failPromotion = async (message: string) => {
        const revokeAccess = Boolean(change.accessGrantedAt && !change.accessRevokedAt);
        const failed = await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            status: "FAILED",
            operationStatus: "FAILED",
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            failureCode: "REPLACEMENT_COMMERCIAL_EVIDENCE_INVALID",
            lastError: message,
            failedAt: now,
            accessRevokedAt: revokeAccess ? now : undefined,
          },
        });
        if (revokeAccess && change.branchId) {
          if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
            await tx.branch.updateMany({
              where: { id: change.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
            });
          }
          if (change.type === "BRANCH_REACTIVATION") {
            await tx.branch.updateMany({
              where: { id: change.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
            });
          }
        }
        return { promoted: false, manualReview: true, change: failed, subscription: candidate };
      };

      let frozenIntent;
      try {
        frozenIntent = readCommercialIntentSnapshot(change, { requireBoundSubscription: true });
      } catch {
        return failPromotion("Replacement commercial authorization is missing or invalid");
      }
      const paidLooking = Boolean(
        candidate.paidThrough
        && candidate.lastConfirmedInvoiceId
        && candidate.lastConfirmedPaymentId
        && candidate.currentStart
        && candidate.currentEnd
        && candidate.currentStart <= now
        && candidate.currentEnd > now
        && candidate.paidThrough.getTime() >= candidate.currentEnd.getTime()
      );
      const invoiceEvidence = candidate.lastConfirmedInvoiceId
        ? await tx.organizationSubscriptionInvoice.findUnique({
            where: { razorpayInvoiceId: candidate.lastConfirmedInvoiceId },
          })
        : null;
      const exactCommercialTuple = candidate.confirmedCommercialIntentChangeId === change.id
        && frozenIntent.authorizedProviderMode === candidate.providerMode
        && frozenIntent.authorizedSourceRazorpaySubscriptionId === source.razorpaySubscriptionId
        && frozenIntent.authorizedRazorpaySubscriptionId === candidate.razorpaySubscriptionId
        && frozenIntent.authorizedRazorpayPlanId === candidate.razorpayPlanId
        && frozenIntent.authorizedPlan === candidate.plan
        && frozenIntent.authorizedQuantity === candidate.quantity;
      const exactInvoiceEvidence = Boolean(
        invoiceEvidence
        && invoiceEvidence.commercialEvidenceVersion === 1
        && invoiceEvidence.commercialIntentChangeId === change.id
        && invoiceEvidence.organizationSubscriptionId === candidate.id
        && invoiceEvidence.providerMode === candidate.providerMode
        && invoiceEvidence.razorpaySubscriptionId === candidate.razorpaySubscriptionId
        && invoiceEvidence.razorpayPlanId === candidate.razorpayPlanId
        && invoiceEvidence.providerQuantity === candidate.quantity
        && invoiceEvidence.razorpayOfferId === frozenIntent.authorizedRazorpayOfferId
        && invoiceEvidence.razorpayPaymentId === candidate.lastConfirmedPaymentId
        && invoiceEvidence.paymentStatus?.toLowerCase() === "captured"
        && invoiceEvidence.paymentCaptured === true
        && invoiceEvidence.periodEnd?.getTime() === candidate.currentEnd?.getTime()
        && invoiceEvidence.periodEnd?.getTime() === candidate.paidThrough?.getTime()
      );
      const hasPaidPeriod = paidLooking && exactCommercialTuple && exactInvoiceEvidence;

      if (paidLooking && !hasPaidPeriod) {
        return failPromotion("Replacement paid state lacks exact linked commercial evidence");
      }

      if (hasPaidPeriod && !["CANCELLED", "COMPLETED", "EXPIRED"].includes(source.status)) {
        return failPromotion("Both source and replacement may have charged during cutover");
      }

      const ready = isReplacementPromotionReady({
        sourceStatus: source.status,
        providerStatus: candidate.status,
        paymentMethod: candidate.providerPaymentMethod,
        providerPlanId: candidate.razorpayPlanId,
        providerQuantity: candidate.quantity,
        targetPlanId: frozenIntent.authorizedRazorpayPlanId,
        targetQuantity: frozenIntent.authorizedQuantity,
        confirmedPaidPeriod: hasPaidPeriod,
      });
      if (!ready) return { promoted: false, manualReview: false, change, subscription: candidate };
      if (source.currentOrganizationId !== change.organizationId
        || candidate.pendingReplacementOrganizationId !== change.organizationId) {
        throw new Error("Replacement subscription slots changed before promotion");
      }

      await tx.organizationSubscription.update({
        where: { id: source.id },
        data: { currentOrganizationId: null },
      });
      const promoted = await tx.organizationSubscription.update({
        where: { id: candidate.id },
        data: {
          pendingReplacementOrganizationId: null,
          currentOrganizationId: change.organizationId,
        },
      });
      if (change.branchId
        && ["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE", "BRANCH_REACTIVATION"].includes(change.type)) {
        await tx.branch.update({
          where: { id: change.branchId },
          data: { billingStatus: "ACTIVE", billingActivatedAt: now, billingArchivedAt: null },
        });
      }
      if (change.branchId && change.type === "BRANCH_REMOVAL") {
        await tx.branch.update({
          where: { id: change.branchId },
          data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
        });
      }
      const applied = await tx.organizationBillingChange.update({
        where: { id: change.id },
        data: {
          status: "APPLIED",
          operationStatus: "APPLIED",
          providerConfirmedAt: now,
          appliedAt: now,
          resolvedAt: now,
          accessRevokedAt: change.accessGrantedAt ? now : undefined,
          lastError: null,
        },
      });
      await tx.organizationSubscriptionHistory.upsert({
        where: { dedupeKey: `replacement-promoted:${candidate.razorpaySubscriptionId}` },
        create: {
          organizationId: change.organizationId,
          organizationSubscriptionId: candidate.id,
          razorpaySubscriptionId: candidate.razorpaySubscriptionId,
          razorpayPaymentId: candidate.lastConfirmedPaymentId,
          plan: candidate.plan,
          fromStatus: source.status,
          toStatus: candidate.status,
          source: "SYSTEM",
          event: "replacement_promoted",
          amountSubunits: candidate.amountSubunits,
          quantity: candidate.quantity,
          unitAmountSubunits: candidate.amountSubunits,
          totalAmountSubunits: candidate.amountSubunits * candidate.quantity,
          paidThrough: candidate.paidThrough,
          dedupeKey: `replacement-promoted:${candidate.razorpaySubscriptionId}`,
          currency: candidate.currency,
        },
        update: { paidThrough: candidate.paidThrough },
      });
      return { promoted: true, change: applied, subscription: promoted };
    });
  }

  /** Reconciles an ambiguous candidate cancellation using provider reads only. */
  static async reconcileCandidateCancellation(changeId: string, now = new Date()) {
    const snapshot = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      include: { organizationSubscription: true, replacementSubscription: true },
    }) as ReplacementCancellationChange | null;
    const candidate = snapshot?.replacementSubscription;
    const intent = snapshot ? candidateCancellationIntentFromChange(snapshot) : null;
    if (!snapshot || !candidate || !intent) {
      throw new Error("Replacement cancellation reconciliation is not available");
    }
    if (snapshot.status === "PROCESSING") {
      throw new BillingChangeInProgressError(snapshot.id, "Replacement candidate cancellation is processing");
    }
    if (candidate.providerMode !== resolveRazorpayMode()) {
      throw new Error("Replacement candidate belongs to another Razorpay mode");
    }

    const retainManualReview = async (error: unknown) => {
      const retained = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
        `;
        const current = await tx.organizationBillingChange.findUnique({
          where: { id: snapshot.id },
        });
        if (!current
          || current.status !== snapshot.status
          || current.updatedAt.getTime() !== snapshot.updatedAt.getTime()
          || current.attemptCount !== snapshot.attemptCount
          || current.failureCode !== snapshot.failureCode) {
          return current ?? snapshot;
        }
        const outcomeUnknownCode = intent === "FAILURE"
          ? CANDIDATE_CANCELLATION_OUTCOME_UNKNOWN_CODE
          : undoCancellationCode(REPLACEMENT_UNDO_CANCELLATION_OUTCOME_UNKNOWN_PREFIX, intent);
        const updated = await tx.organizationBillingChange.update({
          where: { id: current.id },
          data: {
            status: "FAILED",
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            failureCode: outcomeUnknownCode,
            lastError: `Provider read did not confirm candidate cancellation: ${cancellationErrorMessage(error)}`,
            failedAt: current.failedAt ?? now,
            resolvedAt: null,
          },
        });
        await recordBillingMutationAudit(tx, {
          changeId: current.id,
          organizationId: current.organizationId,
          organizationSubscriptionId: current.organizationSubscriptionId,
          attemptCount: current.attemptCount,
          outcome: "MANUAL_REVIEW_RETAINED",
          failureCode: outcomeUnknownCode,
        });
        return updated;
      });
      throw new BillingManualReviewRequiredError(retained.id);
    };

    let provider: RazorpaySubscription;
    try {
      provider = await getRazorpayClient().fetchSubscription(candidate.razorpaySubscriptionId);
      assertExactCandidateSubscriptionResponse(provider, candidate);
    } catch (error) {
      return retainManualReview(error);
    }

    const providerTerminal = TERMINAL_PROVIDER_STATUSES.has(provider.status.toLowerCase());
    const definitelyRejectedAttempt = snapshot.failureCode === CANDIDATE_CANCELLATION_PROVIDER_REJECTED_CODE
      || snapshot.failureCode?.startsWith(REPLACEMENT_UNDO_CANCELLATION_PROVIDER_REJECTED_PREFIX) === true;
    if (!providerTerminal && !definitelyRejectedAttempt) {
      return retainManualReview(new Error("Provider candidate is still nonterminal"));
    }

    if (!providerTerminal) {
      return prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: snapshot.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (organization.billingMutationLeaseToken) {
          throw new BillingChangeInProgressError(snapshot.id, "Another billing operation is still processing");
        }
        const retrySafeCode = intent === "FAILURE"
          ? CANDIDATE_CANCELLATION_RETRY_SAFE_CODE
          : undoCancellationCode(REPLACEMENT_UNDO_CANCELLATION_RETRY_SAFE_PREFIX, intent);
        const reconciled = await tx.organizationBillingChange.updateMany({
          where: {
            id: snapshot.id,
            status: snapshot.status,
            attemptCount: snapshot.attemptCount,
            processingStartedAt: snapshot.processingStartedAt,
            failureCode: snapshot.failureCode,
            updatedAt: snapshot.updatedAt,
          },
          data: {
            failureCategory: "PROVIDER_REJECTED",
            failureCode: retrySafeCode,
            lastError: "Provider read confirmed the definitely rejected cancellation did not terminate the candidate",
            resolvedAt: now,
          },
        });
        if (reconciled.count !== 1) {
          throw new BillingChangeInProgressError(snapshot.id, "Replacement changed during cancellation reconciliation");
        }
        await recordBillingMutationAudit(tx, {
          changeId: snapshot.id,
          organizationId: snapshot.organizationId,
          organizationSubscriptionId: snapshot.organizationSubscriptionId,
          attemptCount: snapshot.attemptCount,
          outcome: "PROVIDER_STATE_ADOPTED",
          failureCode: retrySafeCode,
        });
        return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: snapshot.id } });
      });
    }

    return prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: snapshot.organizationId },
        select: { billingMutationLeaseToken: true },
      });
      if (organization.billingMutationLeaseToken) {
        throw new BillingChangeInProgressError(snapshot.id, "Another billing operation is still processing");
      }
      const current = await tx.organizationBillingChange.findUnique({
        where: { id: snapshot.id },
        include: { organizationSubscription: true, replacementSubscription: true },
      }) as ReplacementCancellationChange | null;
      if (!current?.replacementSubscription
        || current.replacementSubscription.id !== candidate.id
        || candidateCancellationIntentFromChange(current) !== intent) {
        throw new BillingChangeInProgressError(snapshot.id, "Replacement changed during cancellation reconciliation");
      }
      return finalizeCandidateCancellation(tx, {
        change: current,
        provider,
        intent,
        now,
        expectedWhere: {
          status: snapshot.status,
          attemptCount: snapshot.attemptCount,
          processingStartedAt: snapshot.processingStartedAt,
          failureCode: snapshot.failureCode,
          updatedAt: snapshot.updatedAt,
        },
      });
    });
  }

  /** Retries only a cancellation that a prior exact provider read marked safe. */
  static async retryCandidateCancellation(changeId: string, now = new Date()) {
    const change = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      select: { failureCode: true, operationStatus: true, lastError: true },
    });
    const intent = candidateCancellationRetryIntent(change?.failureCode);
    if (!change || !intent || !change.failureCode) {
      throw new Error("Replacement candidate cancellation is not safe to retry");
    }
    if (intent === "FAILURE") {
      const event = ["ABANDONED", "DECLINED", "FAILED"].includes(change.operationStatus)
        ? change.operationStatus as "ABANDONED" | "DECLINED" | "FAILED"
        : "FAILED";
      return this.failReplacementCheckout(
        changeId,
        event,
        now,
        change.lastError ?? "Retrying a definitely rejected replacement candidate cancellation",
        { expectedFailureCode: change.failureCode }
      );
    }
    return this.undoReplacement(changeId, now, {
      branchDisposition: intent === "UNDO_ARCHIVE" ? "ARCHIVE" : "RESTORE",
      expectedFailureCode: change.failureCode,
    });
  }

  static async undoReplacement(
    changeId: string,
    now = new Date(),
    options: {
      branchDisposition?: "RESTORE" | "ARCHIVE";
      expectedFailureCode?: string;
    } = {}
  ) {
    const snapshot = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      select: { organizationId: true },
    });
    if (!snapshot) throw new Error("Replacement billing change not found");
    assertRazorpayBillingWritesEnabled(snapshot.organizationId);
    const razorpay = getRazorpayClient();
    const leaseToken = crypto.randomUUID();
    const intent: CandidateCancellationIntent = options.branchDisposition === "ARCHIVE"
      ? "UNDO_ARCHIVE"
      : "UNDO_RESTORE";
    const processingCode = undoCancellationCode(
      REPLACEMENT_UNDO_CANCELLATION_PROCESSING_PREFIX,
      intent
    );
    const outcomeUnknownCode = undoCancellationCode(
      REPLACEMENT_UNDO_CANCELLATION_OUTCOME_UNKNOWN_PREFIX,
      intent
    );
    const providerRejectedCode = undoCancellationCode(
      REPLACEMENT_UNDO_CANCELLATION_PROVIDER_REJECTED_PREFIX,
      intent
    );
    const claim = await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: snapshot.organizationId },
        select: { billingMutationLeaseToken: true, billingMutationLeaseUntil: true },
      });
      if (organization.billingMutationLeaseToken
        || (organization.billingMutationLeaseUntil && organization.billingMutationLeaseUntil > now)) {
        throw new BillingChangeInProgressError(changeId, "Another billing operation is still processing");
      }
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: { replacementSubscription: true },
      });
      const candidate = change?.replacementSubscription;
      if (!change || !candidate) throw new Error("Replacement billing change not found");
      if (options.expectedFailureCode && change.failureCode !== options.expectedFailureCode) {
        throw new BillingChangeInProgressError(
          change.id,
          "Replacement cancellation state changed before its safe retry"
        );
      }
      const retryIntent = candidateCancellationRetryIntent(change.failureCode);
      if (retryIntent === "FAILURE" || (retryIntent && retryIntent !== intent)) {
        throw new BillingChangeInProgressError(
          change.id,
          "Replacement cancellation must retain its reconciled cleanup intent"
        );
      }
      if (change.status === "PROCESSING"
        || change.failureCategory === "MANUAL_REVIEW_REQUIRED") {
        throw new BillingChangeInProgressError(
          change.id,
          "The replacement provider outcome must be reconciled before it can be undone"
        );
      }
      if (change.status === "APPLIED") throw new Error("The replacement has already been applied");
      if (change.undoCutoffAt && now >= change.undoCutoffAt) {
        throw new Error("The replacement can no longer be undone");
      }
      if (candidate.pendingReplacementOrganizationId !== change.organizationId) {
        throw new Error("The replacement is no longer pending for this workspace");
      }
      if (isCandidateCancellationReconciliationCode(change.failureCode)) {
        throw new BillingManualReviewRequiredError(
          change.id,
          "The earlier replacement cancellation must be reconciled before another mutation"
        );
      }
      const attemptCount = change.attemptCount + 1;
      const processingStartedAt = now;
      const claimed = await tx.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          status: change.status,
          attemptCount: change.attemptCount,
          updatedAt: change.updatedAt,
        },
        data: {
          status: "PROCESSING",
          operationStatus: "ABANDONED",
          failureCategory: null,
          failureCode: processingCode,
          lastError: "Replacement candidate cancellation is processing",
          resolvedAt: null,
          attemptCount,
          processingStartedAt,
        },
      });
      if (claimed.count !== 1) {
        throw new BillingChangeInProgressError(change.id, "Replacement changed while undo was claimed");
      }
      await tx.organization.update({
        where: { id: change.organizationId },
        data: {
          billingMutationLeaseToken: leaseToken,
          billingMutationLeaseUntil: new Date(now.getTime() + REPLACEMENT_PROVIDER_LEASE_MS),
        },
      });
      const processingChange = await tx.organizationBillingChange.findUniqueOrThrow({
        where: { id: change.id },
      });
      return { change: processingChange, candidate };
    });
    try {
      const cancelled = await razorpay.cancelSubscription(
        claim.candidate.razorpaySubscriptionId,
        { cancel_at_cycle_end: false }
      );
      assertTerminalCandidateCancellationResponse(cancelled, claim.candidate);
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${claim.change.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: claim.change.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (organization.billingMutationLeaseToken !== leaseToken) {
          throw new Error("Billing mutation lease was lost while undoing replacement");
        }
        const latest = await tx.organizationBillingChange.findUnique({
          where: { id: claim.change.id },
          include: { organizationSubscription: true, replacementSubscription: true },
        }) as ReplacementCancellationChange | null;
        if (!latest?.replacementSubscription
          || latest.replacementSubscription.id !== claim.candidate.id) {
          throw new Error("Replacement changed before undo completed");
        }
        const undone = await finalizeCandidateCancellation(tx, {
          change: latest,
          provider: cancelled,
          intent,
          now,
          expectedWhere: {
            status: "PROCESSING",
            attemptCount: claim.change.attemptCount,
            processingStartedAt: claim.change.processingStartedAt,
            failureCode: processingCode,
          },
        });
        await releaseLease(tx, claim.change.organizationId, leaseToken);
        return undone;
      });
    } catch (error) {
      if (isDefinitelyRejectedProviderError(error)) {
        await finalizeRejectedCandidateCancellationAttempt({
          change: claim.change,
          leaseToken,
          processingCode,
          rejectedCode: providerRejectedCode,
          error,
          now,
        });
        throw error;
      }
      const quarantined = await quarantineCandidateCancellationAttempt({
        change: claim.change,
        leaseToken,
        processingCode,
        outcomeUnknownCode,
        error,
        now,
      });
      if (quarantined.failureCategory === "MANUAL_REVIEW_REQUIRED") {
        throw new BillingManualReviewRequiredError(quarantined.id);
      }
      throw error;
    }
  }
}

export function isReplacementChangeType(type: BillingChangeType) {
  return [
    "PAYMENT_METHOD_REPLACEMENT",
    "TRIAL_SUBSCRIPTION_UPDATE",
    "PLAN_UPGRADE",
    "PLAN_DOWNGRADE",
    "QUANTITY_INCREASE",
    "BRANCH_REMOVAL",
    "BRANCH_REACTIVATION",
  ].includes(type);
}
