import { executeBillingProviderAction, confirmReconciledBillingProviderAction, isDefinitelyRejectedBillingProviderError } from "@/services/billingProviderAction.service";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  getRazorpayClient,
  resolveRazorpayMode,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import {
  areRazorpayMultiMethodSubscriptionsEnabled,
  areRazorpayBillingWritesEnabled,
  assertRazorpayBillingWritesEnabled,
} from "@/lib/billingFeature";
import { getBillingPlan } from "@/lib/billingPlans";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
} from "@/lib/billingErrors";
import { ensureRazorpayPlanCatalogEntry } from "@/services/razorpayPlanCatalog.service";
import { BillingReplacementService } from "@/services/billingReplacement.service";
import { isReplacementMutationEligible } from "@/services/billingReplacementPolicy";
import {
  buildCommercialIntentSnapshot,
  captureProcessingCommercialIntent,
  readCommercialIntentSnapshot,
} from "@/services/billingCommercialEvidence.service";
import { recordBillingMutationAudit } from "@/services/billingMutationAudit.service";
import type {
  BillingChangeType,
  OrganizationBillingChange,
  Prisma,
  SaasPlan,
} from "@/app/generated/prisma/client";

const LEASE_MS = 2 * 60 * 1000;
const IMMEDIATE_TYPES = new Set<BillingChangeType>([
  "TRIAL_SUBSCRIPTION_UPDATE",
  "PLAN_UPGRADE",
  "QUANTITY_INCREASE",
  "BRANCH_REACTIVATION",
  "UNSUPPORTED_METHOD_CANCELLATION",
]);
const QUANTITY_TYPES = new Set<BillingChangeType>([
  "TRIAL_SUBSCRIPTION_UPDATE",
  "QUANTITY_INCREASE",
  "BRANCH_REMOVAL",
  "BRANCH_REACTIVATION",
  "LEGACY_TRANSITION",
]);
const SOURCE_CHANGED_MESSAGE = "Billing mutation source subscription is no longer current";
const MANUAL_REVIEW_CATEGORY = "MANUAL_REVIEW_REQUIRED";
const AMBIGUOUS_PROVIDER_FAILURE_CODE = "PROVIDER_MUTATION_OUTCOME_UNKNOWN";
const SCHEDULED_UNDO_PROCESSING_CODE = "SCHEDULED_UNDO_PROCESSING";
const SCHEDULED_UNDO_RETRY_PROCESSING_CODE = "SCHEDULED_UNDO_RETRY_PROCESSING";
const SCHEDULED_UNDO_OUTCOME_UNKNOWN_CODE = "SCHEDULED_UNDO_OUTCOME_UNKNOWN";
const SCHEDULED_UNDO_RECONCILIATION_FAILED_CODE = "SCHEDULED_UNDO_RECONCILIATION_FAILED";
const SCHEDULED_UNDO_PROVIDER_REJECTED_CODE = "SCHEDULED_UNDO_PROVIDER_REJECTED";
const SCHEDULED_UNDO_PRE_PROVIDER_FAILURE_CODE = "SCHEDULED_UNDO_PRE_PROVIDER_FAILURE";
const DEFINITE_PROVIDER_FAILURE_CATEGORY = "PROVIDER_REJECTED";
const PRE_PROVIDER_FAILURE_CATEGORY = "PRE_PROVIDER_FAILURE";
const SAFE_RETRY_FAILURE_CATEGORIES = new Set([
  DEFINITE_PROVIDER_FAILURE_CATEGORY,
  PRE_PROVIDER_FAILURE_CATEGORY,
]);

class BillingMutationSourceChangedError extends Error {
  constructor() {
    super(SOURCE_CHANGED_MESSAGE);
    this.name = "BillingMutationSourceChangedError";
  }
}

class ScheduledUndoReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledUndoReconciliationError";
  }
}

const isDefinitelyRejectedProviderError = isDefinitelyRejectedBillingProviderError;

function assertProviderMutationResponse(value: unknown): asserts value is RazorpaySubscription {
  if (!value || typeof value !== "object") {
    throw new Error("Razorpay returned a malformed subscription mutation response");
  }
  const candidate = value as Partial<RazorpaySubscription>;
  if (candidate.entity !== "subscription"
    || typeof candidate.id !== "string"
    || candidate.id.length === 0
    || typeof candidate.plan_id !== "string"
    || candidate.plan_id.length === 0
    || typeof candidate.status !== "string"
    || !["created", "authenticated", "active", "pending", "paused", "halted", "cancelled", "completed", "expired"]
      .includes(candidate.status.toLowerCase())
    || !Number.isInteger(candidate.total_count)
    || (candidate.total_count ?? 0) < 1
    || !Number.isInteger(candidate.quantity)
    || (candidate.quantity ?? 0) < 1) {
    throw new Error("Razorpay returned a malformed subscription mutation response");
  }
}

type ProviderMutationExecution = {
  provider: RazorpaySubscription;
  subscriptionId: string;
  sourcePlanId: string;
  sourceQuantity: number;
  targetPlanId: string;
  targetQuantity: number;
  scheduleChangeAt: "now" | "cycle_end";
  cancellation: boolean;
};

type ProviderMutationFinalizationExpectation =
  | {
      status: "PROCESSING";
      attemptCount: number;
      processingStartedAt: Date | null;
    }
  | {
      status: "FAILED";
      updatedAt: Date;
    };

function assertProviderMutationMatchesExpectation(execution: ProviderMutationExecution) {
  const { provider } = execution;
  if (provider.id !== execution.subscriptionId) {
    throw new Error("Razorpay subscription mismatch while applying billing mutation");
  }
  const terminal = ["cancelled", "completed", "expired"].includes(provider.status.toLowerCase());
  if (execution.cancellation) {
    if (!terminal
      && (execution.scheduleChangeAt !== "cycle_end" || provider.has_scheduled_changes !== true)) {
      throw new Error("Razorpay cancellation response does not confirm the requested state");
    }
    return;
  }
  const targetEchoed = provider.plan_id === execution.targetPlanId
    && provider.quantity === execution.targetQuantity;
  const scheduledSourceEchoed = execution.scheduleChangeAt === "cycle_end"
    && provider.has_scheduled_changes === true
    && provider.plan_id === execution.sourcePlanId
    && provider.quantity === execution.sourceQuantity;
  if (!targetEchoed && !scheduledSourceEchoed) {
    throw new Error("Razorpay subscription response does not match the requested billing mutation");
  }
}

function providerConfirmsExactMutationTarget(execution: ProviderMutationExecution) {
  const provider = execution.provider;
  if (provider.id !== execution.subscriptionId) return false;
  const terminal = ["cancelled", "completed", "expired"].includes(provider.status.toLowerCase());
  if (execution.cancellation) {
    if (terminal) return true;
    return execution.scheduleChangeAt === "cycle_end"
      && provider.plan_id === execution.sourcePlanId
      && provider.quantity === execution.sourceQuantity
      && provider.has_scheduled_changes === true;
  }
  const targetEchoed = provider.plan_id === execution.targetPlanId
    && provider.quantity === execution.targetQuantity;
  return execution.scheduleChangeAt === "now"
    ? targetEchoed && provider.has_scheduled_changes !== true && !terminal
    : targetEchoed && provider.has_scheduled_changes === true && !terminal;
}

function providerExecutionForManualReconciliation(
  change: OrganizationBillingChange,
  subscription: {
    razorpaySubscriptionId: string;
    razorpayPlanId: string;
    quantity: number;
    plan: SaasPlan;
  },
  provider: RazorpaySubscription
): ProviderMutationExecution | null {
  let commercialIntent;
  try {
    commercialIntent = readCommercialIntentSnapshot(change, { requireBoundSubscription: true });
  } catch {
    return null;
  }
  if (commercialIntent.authorizedRazorpaySubscriptionId
      !== subscription.razorpaySubscriptionId
    || (change.toPlan != null && change.toPlan !== commercialIntent.authorizedPlan)
    || (change.toQuantity != null
      && change.toQuantity !== commercialIntent.authorizedQuantity)) {
    return null;
  }
  const cancellation = change.type === "CANCELLATION"
    || change.type === "UNSUPPORTED_METHOD_CANCELLATION";
  const scheduleChangeAt = change.type === "CANCELLATION"
    ? "cycle_end" as const
    : IMMEDIATE_TYPES.has(change.type)
      ? "now" as const
      : "cycle_end" as const;
  return {
    provider,
    subscriptionId: subscription.razorpaySubscriptionId,
    sourcePlanId: commercialIntent.authorizedSourceRazorpayPlanId
      ?? subscription.razorpayPlanId,
    sourceQuantity: subscription.quantity,
    targetPlanId: commercialIntent.authorizedRazorpayPlanId,
    targetQuantity: commercialIntent.authorizedQuantity,
    scheduleChangeAt,
    cancellation,
  };
}

function providerStillMatchesMutationSource(
  change: OrganizationBillingChange,
  subscription: {
    razorpaySubscriptionId: string;
    razorpayPlanId: string;
    quantity: number;
  },
  provider: RazorpaySubscription
) {
  const terminal = ["cancelled", "completed", "expired"].includes(provider.status.toLowerCase());
  return provider.id === subscription.razorpaySubscriptionId
    && provider.plan_id === subscription.razorpayPlanId
    && provider.quantity === subscription.quantity
    && provider.has_scheduled_changes !== true
    && !terminal
    && (change.type !== "CANCELLATION" || provider.change_scheduled_at == null);
}

function providerConfirmsScheduledUndoComplete(
  subscription: {
    razorpaySubscriptionId: string;
    razorpayPlanId: string;
    quantity: number;
  },
  provider: RazorpaySubscription
) {
  const terminal = ["cancelled", "completed", "expired"].includes(provider.status.toLowerCase());
  return provider.id === subscription.razorpaySubscriptionId
    && provider.plan_id === subscription.razorpayPlanId
    && provider.quantity === subscription.quantity
    && provider.has_scheduled_changes === false
    && !terminal;
}

function providerConfirmsScheduledChangeStillPending(
  subscription: {
    razorpaySubscriptionId: string;
    razorpayPlanId: string;
    quantity: number;
  },
  provider: RazorpaySubscription
) {
  const terminal = ["cancelled", "completed", "expired"].includes(provider.status.toLowerCase());
  return provider.id === subscription.razorpaySubscriptionId
    && provider.plan_id === subscription.razorpayPlanId
    && provider.quantity === subscription.quantity
    && provider.has_scheduled_changes === true
    && !terminal;
}

function isScheduledUndoFailureCode(code: string | null) {
  return code === SCHEDULED_UNDO_OUTCOME_UNKNOWN_CODE
    || code === SCHEDULED_UNDO_RECONCILIATION_FAILED_CODE
    || code === "SCHEDULED_UNDO_LEASE_EXPIRED";
}

export function isSafeFailedBillingMutationForLocalUndo(failureCategory: string | null) {
  return SAFE_RETRY_FAILURE_CATEGORIES.has(failureCategory ?? "");
}

type EnqueueInput = {
  organizationId: string;
  subscriptionId?: string | null;
  branchId?: string | null;
  idempotencyKey: string;
  type: BillingChangeType;
  fromPlan?: SaasPlan | null;
  toPlan?: SaasPlan | null;
  fromQuantity?: number | null;
  toQuantity?: number | null;
  effectiveAt?: Date | null;
  undoCutoffAt?: Date | null;
  createdByUserId?: string | null;
  status?: "QUEUED" | "PROCESSING" | "AWAITING_PAYMENT" | "SCHEDULED" | "APPLIED" | "UNDONE" | "FAILED" | "SUPERSEDED";
  operationStatus?: "CHECKOUT_OPEN" | "VERIFYING" | "AWAITING_PROVIDER_CONFIRMATION" | "APPLIED" | "DECLINED" | "ABANDONED" | "FAILED" | "SCHEDULED";
  returnPath?: string | null;
  confirmationDeadlineAt?: Date | null;
  checkoutOpenedAt?: Date | null;
};

function timestamp(value: Date | null | undefined) {
  return value ? Math.floor(value.getTime() / 1000) : undefined;
}

function providerStatus(status: string) {
  const normalized = status.toUpperCase();
  return ["CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "PAUSED", "HALTED", "CANCELLED", "COMPLETED", "EXPIRED"]
    .includes(normalized) ? normalized : "PENDING";
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

export class BillingMutationService {
  static async enqueue(input: EnqueueInput) {
    return prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${input.organizationId} FOR UPDATE
      `;

      const duplicate = await tx.organizationBillingChange.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (duplicate) {
        const inputMismatch = duplicate.organizationId !== input.organizationId
          || duplicate.type !== input.type
          || (input.subscriptionId !== undefined
            && duplicate.organizationSubscriptionId !== (input.subscriptionId ?? null))
          || (input.branchId !== undefined && duplicate.branchId !== (input.branchId ?? null))
          || (input.fromPlan !== undefined && duplicate.fromPlan !== (input.fromPlan ?? null))
          || (input.toPlan !== undefined && duplicate.toPlan !== (input.toPlan ?? null))
          || (input.fromQuantity !== undefined
            && duplicate.fromQuantity !== (input.fromQuantity ?? null))
          || (input.toQuantity !== undefined && duplicate.toQuantity !== (input.toQuantity ?? null));
        if (inputMismatch) {
          throw new Error("Idempotency key was already used for another billing operation");
        }
        return duplicate;
      }

      if (input.type !== "SUBSCRIPTION_AUTHORIZATION"
        && input.type !== "UNSUPPORTED_METHOD_CANCELLATION") {
        await BillingReplacementService.assertNoOpenReplacement(tx, input.organizationId);
      }

      const organization = await tx.organization.update({
        where: { id: input.organizationId },
        data: { billingMutationSequence: { increment: 1 } },
        select: { billingMutationSequence: true },
      });

      let toQuantity = input.toQuantity ?? null;
      if (QUANTITY_TYPES.has(input.type) && toQuantity == null) {
        toQuantity = await tx.branch.count({
          where: {
            organizationId: input.organizationId,
            billingStatus: input.type === "BRANCH_REMOVAL"
              ? { in: ["ACTIVE", "PENDING_ACTIVATION"] }
              : { not: "ARCHIVED" },
          },
        });
      }
      if (toQuantity != null && toQuantity < 1) {
        throw new Error("A subscription must retain at least one billable branch");
      }

      return tx.organizationBillingChange.create({
        data: {
          organizationId: input.organizationId,
          organizationSubscriptionId: input.subscriptionId ?? null,
          branchId: input.branchId ?? null,
          sequence: organization.billingMutationSequence,
          idempotencyKey: input.idempotencyKey,
          type: input.type,
          status: input.status ?? "QUEUED",
          operationStatus: input.operationStatus ?? "AWAITING_PROVIDER_CONFIRMATION",
          fromPlan: input.fromPlan ?? null,
          toPlan: input.toPlan ?? null,
          fromQuantity: input.fromQuantity ?? null,
          toQuantity,
          effectiveAt: input.effectiveAt ?? null,
          undoCutoffAt: input.undoCutoffAt ?? null,
          createdByUserId: input.createdByUserId ?? null,
          returnPath: input.returnPath ?? null,
          confirmationDeadlineAt: input.confirmationDeadlineAt ?? null,
          checkoutOpenedAt: input.checkoutOpenedAt ?? null,
        },
      });
    });
  }

  static async processNext(organizationId: string, now = new Date()) {
    const leaseToken = crypto.randomUUID();
    const claimed = await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUnique({ where: { id: organizationId } });
      if (!organization) throw new Error("Organization not found");
      // Only deadline CAS recovery may clear an expired token. A new worker
      // must not overwrite it while the previous provider call may still end.
      if (organization.billingMutationLeaseToken
        || (organization.billingMutationLeaseUntil && organization.billingMutationLeaseUntil > now)) {
        return null;
      }

      const safetyCancellation = await tx.organizationBillingChange.findFirst({
        where: {
          organizationId,
          status: "QUEUED",
          type: "UNSUPPORTED_METHOD_CANCELLATION",
        },
        orderBy: { sequence: "asc" },
      });
      const next = safetyCancellation ?? await tx.organizationBillingChange.findFirst({
          where: { organizationId, status: "QUEUED" },
          orderBy: { sequence: "asc" },
        });
      if (!next) return null;

      // A cancellation scheduled locally remains deliberately idle until its
      // undo cutoff. Because it is the earliest queued intent, later provider
      // mutations must not jump ahead of it and invalidate the customer's
      // scheduled state.
      if (next.type === "CANCELLATION"
        && next.undoCutoffAt
        && next.undoCutoffAt > now) {
        return null;
      }

      // Provider mutations are FIFO through confirmation, not merely through
      // the outbound HTTP request. Razorpay may have accepted an earlier
      // mutation while its invoice/payment is still unresolved, and it only
      // supports one coherent scheduled-change intent at a time. Letting a
      // later change pass either state makes reconciliation ambiguous.
      const unresolvedEarlier = await tx.organizationBillingChange.findFirst({
        where: {
          organizationId,
          sequence: { lt: next.sequence },
          OR: next.type === "UNSUPPORTED_METHOD_CANCELLATION"
            ? [{ status: "PROCESSING" }]
            : [
                { status: { in: ["PROCESSING", "AWAITING_PAYMENT", "SCHEDULED"] } },
                {
                  status: "FAILED",
                  type: { not: "SUBSCRIPTION_AUTHORIZATION" },
                },
              ],
        },
        orderBy: { sequence: "asc" },
      });
      if (unresolvedEarlier) return null;

      // Do not claim a normal mutation, increment its attempt counter, or turn
      // it into a failure while the deployment-wide billing hold is active.
      // Unsupported-method cancellation is a safety action and remains exempt.
      if (next.type !== "UNSUPPORTED_METHOD_CANCELLATION"
        && !areRazorpayBillingWritesEnabled(organizationId)) {
        return null;
      }

      // A queued mutation belongs to the immutable subscription row captured
      // when the intent was created. Never carry that intent across a
      // replacement promotion to whichever row happens to be current later.
      const source = next.organizationSubscriptionId
        ? await tx.organizationSubscription.findUnique({
            where: { id: next.organizationSubscriptionId },
            select: { organizationId: true, currentOrganizationId: true },
          })
        : null;
      if (!source
        || source.organizationId !== organizationId
        || source.currentOrganizationId !== organizationId) {
        await tx.organizationBillingChange.update({
          where: { id: next.id },
          data: {
            status: "SUPERSEDED",
            operationStatus: "ABANDONED",
            resolvedAt: now,
            lastError: SOURCE_CHANGED_MESSAGE,
          },
        });
        return null;
      }

      await tx.organization.update({
        where: { id: organizationId },
        data: {
          billingMutationLeaseToken: leaseToken,
          billingMutationLeaseUntil: new Date(now.getTime() + LEASE_MS),
        },
      });
      return tx.organizationBillingChange.update({
        where: { id: next.id },
        data: {
          status: "PROCESSING",
          attemptCount: { increment: 1 },
          processingStartedAt: now,
          lastError: null,
        },
      });
    });
    if (!claimed) return null;

    let providerCallStarted = false;
    let providerResponseReceived = false;
    try {
      const source = await prisma.organizationSubscription.findUnique({
        where: { id: claimed.organizationSubscriptionId! },
        select: {
          organizationId: true,
          currentOrganizationId: true,
          providerPaymentMethod: true,
        },
      });
      if (!source
        || source.organizationId !== organizationId
        || source.currentOrganizationId !== organizationId) {
        throw new BillingMutationSourceChangedError();
      }
      if (areRazorpayMultiMethodSubscriptionsEnabled()
        && isReplacementMutationEligible({
          sourcePaymentMethod: source.providerPaymentMethod,
          mutationType: claimed.type,
        })) {
        const replacement = await BillingReplacementService.provisionClaimedChange(
          claimed.id,
          leaseToken,
          now
        );
        return replacement.change;
      }
      const execution = await this.executeProviderMutation(claimed, leaseToken, () => {
        providerCallStarted = true;
      });
      providerResponseReceived = true;
      assertProviderMutationResponse(execution.provider);
      assertProviderMutationMatchesExpectation(execution);
      return await this.finalizeProviderMutation(
        claimed,
        execution,
        leaseToken,
        {
          status: "PROCESSING",
          attemptCount: claimed.attemptCount,
          processingStartedAt: claimed.processingStartedAt,
        }
      );
    } catch (error) {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
        `;
        const current = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { billingMutationLeaseToken: true },
        });
        // An expired worker must never fail or release a successor's attempt.
        if (current?.billingMutationLeaseToken !== leaseToken) return;
        const sourceChanged = !providerCallStarted
          && error instanceof BillingMutationSourceChangedError;
        const durable = await tx.organizationBillingChange.findUnique({ where: { id: claimed.id } });
        const ambiguousProviderOutcome = Boolean(durable?.providerMutationAdmittedAt)
          || durable?.failureCategory === MANUAL_REVIEW_CATEGORY
          || error instanceof BillingManualReviewRequiredError
          || providerResponseReceived
          || (providerCallStarted && !isDefinitelyRejectedProviderError(error));
        const failedAt = new Date();
        const persisted = await tx.organizationBillingChange.updateMany({
          where: {
            id: claimed.id,
            status: "PROCESSING",
            attemptCount: claimed.attemptCount,
            processingStartedAt: claimed.processingStartedAt,
          },
          data: {
            status: sourceChanged ? "SUPERSEDED" : "FAILED",
            operationStatus: sourceChanged ? "ABANDONED" : "FAILED",
            failedAt: sourceChanged ? null : failedAt,
            resolvedAt: sourceChanged || !ambiguousProviderOutcome ? failedAt : null,
            failureCategory: sourceChanged
              ? null
              : ambiguousProviderOutcome
                ? MANUAL_REVIEW_CATEGORY
                : providerCallStarted
                  ? DEFINITE_PROVIDER_FAILURE_CATEGORY
                  : PRE_PROVIDER_FAILURE_CATEGORY,
            failureCode: ambiguousProviderOutcome
              ? AMBIGUOUS_PROVIDER_FAILURE_CODE
              : null,
            lastError: error instanceof Error ? error.message : "Provider mutation failed",
          },
        });
        if (persisted.count === 1 && ambiguousProviderOutcome) {
          await recordBillingMutationAudit(tx, {
            changeId: claimed.id,
            organizationId,
            organizationSubscriptionId: claimed.organizationSubscriptionId,
            attemptCount: claimed.attemptCount,
            outcome: "MANUAL_REVIEW_REQUIRED",
            failureCode: AMBIGUOUS_PROVIDER_FAILURE_CODE,
          });
        }
        await releaseLease(tx, organizationId, leaseToken);
      });
      throw error;
    }
  }

  private static async finalizeProviderMutation(
    change: OrganizationBillingChange,
    execution: ProviderMutationExecution,
    leaseToken: string,
    expected: ProviderMutationFinalizationExpectation,
    finalizedAt = new Date(),
    auditOutcome?: "PROVIDER_STATE_ADOPTED"
  ) {
    const result = execution.provider;
    return prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
      `;
      const current = await tx.organization.findUnique({ where: { id: change.organizationId } });
      if (current?.billingMutationLeaseToken !== leaseToken) {
        throw new Error("Billing mutation lease was lost");
      }
      const sourceSubscription = change.organizationSubscriptionId
        ? await tx.organizationSubscription.findUnique({
            where: { id: change.organizationSubscriptionId },
            select: {
              id: true,
              organizationId: true,
              currentOrganizationId: true,
              razorpaySubscriptionId: true,
              status: true,
            },
          })
        : null;
      if (!sourceSubscription
        || sourceSubscription.organizationId !== change.organizationId
        || sourceSubscription.currentOrganizationId !== change.organizationId) {
        throw new BillingMutationSourceChangedError();
      }
      if (result.id !== sourceSubscription.razorpaySubscriptionId) {
        throw new Error("Razorpay subscription mismatch while applying billing mutation");
      }

      const cancellationType = change.type === "CANCELLATION"
        || change.type === "UNSUPPORTED_METHOD_CANCELLATION";
      const cancellationScheduled = change.type === "CANCELLATION"
        && !["cancelled", "completed", "expired"].includes(result.status.toLowerCase());
      const scheduled = (!IMMEDIATE_TYPES.has(change.type) && change.type !== "CANCELLATION")
        || cancellationScheduled;
      const awaitingPayment = ["PLAN_UPGRADE", "QUANTITY_INCREASE", "BRANCH_REACTIVATION"]
        .includes(change.type);
      const status = scheduled ? "SCHEDULED" : awaitingPayment ? "AWAITING_PAYMENT" : "APPLIED";
      const expectedWhere = expected.status === "PROCESSING"
        ? {
            status: expected.status,
            attemptCount: expected.attemptCount,
            processingStartedAt: expected.processingStartedAt,
          }
        : { status: expected.status, updatedAt: expected.updatedAt };
      const finalized = await tx.organizationBillingChange.updateMany({
        where: { id: change.id, ...expectedWhere },
        data: {
          status,
          operationStatus: status === "SCHEDULED"
            ? "SCHEDULED"
            : status === "APPLIED"
              ? "APPLIED"
              : "AWAITING_PROVIDER_CONFIRMATION",
          appliedAt: status === "APPLIED" ? finalizedAt : null,
          providerConfirmedAt: status === "APPLIED" ? finalizedAt : null,
          resolvedAt: status === "APPLIED" ? finalizedAt : null,
          failedAt: null,
          failureCategory: null,
          failureCode: null,
          lastError: null,
        },
      });
      if (finalized.count !== 1) {
        throw new Error("Billing mutation attempt was superseded before finalization");
      }
      await confirmReconciledBillingProviderAction(tx, { organizationId: change.organizationId,
        identity: change.id, purpose: "MUTATE", provider: result });
      const providerPlan = change.type === "TRIAL_SUBSCRIPTION_UPDATE"
        ? await tx.saasRazorpayPlan.findFirst({
            where: {
              razorpayPlanId: result.plan_id,
              providerMode: resolveRazorpayMode(),
            },
          })
        : null;
      const storedSubscription = await tx.organizationSubscription.update({
        where: { id: sourceSubscription.id },
        data: {
          plan: providerPlan?.plan,
          amount: providerPlan?.amount,
          amountSubunits: providerPlan?.amountSubunits,
          currency: providerPlan?.currency,
          period: providerPlan?.period,
          interval: providerPlan?.interval,
          razorpayPlanId: providerPlan?.razorpayPlanId,
          status: providerStatus(result.status) as never,
          // Paid immediate changes and scheduled reductions can both echo the
          // provider's target quantity before it becomes the confirmed billed
          // quantity. Only genuinely applied non-payment changes (including a
          // future trial configuration) may update it here.
          quantity: status === "APPLIED" ? result.quantity ?? undefined : undefined,
          currentStart: result.current_start ? new Date(result.current_start * 1000) : undefined,
          currentEnd: result.current_end ? new Date(result.current_end * 1000) : undefined,
          chargeAt: result.charge_at ? new Date(result.charge_at * 1000) : undefined,
          providerStartAt: result.start_at ? new Date(result.start_at * 1000) : undefined,
          authorizationExpiresAt: result.expire_by ? new Date(result.expire_by * 1000) : undefined,
          lastReconciledAt: finalizedAt,
          cancelAtCycleEnd: cancellationType ? cancellationScheduled : undefined,
          cancellationRequestedAt: cancellationType ? change.createdAt : undefined,
          cancellationScheduledAt: change.type === "CANCELLATION" ? change.effectiveAt : undefined,
          cancelledAt: cancellationType && !cancellationScheduled ? finalizedAt : undefined,
        },
      });
      if (change.type === "CANCELLATION") {
        const dedupeKey = `customer-cancellation:${change.id}`;
        await tx.organizationSubscriptionHistory.upsert({ where: { dedupeKey }, update: {}, create: {
          dedupeKey, organizationId: change.organizationId, organizationSubscriptionId: storedSubscription.id,
          razorpaySubscriptionId: storedSubscription.razorpaySubscriptionId, plan: storedSubscription.plan,
          fromStatus: sourceSubscription.status, toStatus: storedSubscription.status,
          source: "CUSTOMER_CANCELLATION", event: "cancel_at_cycle_end",
          amountSubunits: storedSubscription.amountSubunits, currency: storedSubscription.currency,
          quantity: storedSubscription.quantity, unitAmountSubunits: storedSubscription.amountSubunits,
          totalAmountSubunits: storedSubscription.amountSubunits * storedSubscription.quantity,
        } });
      }
      if (auditOutcome) {
        await recordBillingMutationAudit(tx, {
          changeId: change.id,
          organizationId: change.organizationId,
          organizationSubscriptionId: change.organizationSubscriptionId,
          attemptCount: change.attemptCount,
          outcome: auditOutcome,
        });
      }
      await releaseLease(tx, change.organizationId, leaseToken);
      return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
    });
  }

  static async retry(changeId: string) {
    const change = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      include: { organizationSubscription: true },
    });
    if (!change || change.status !== "FAILED") throw new Error("Failed billing change not found");
    if (change.failureCode?.startsWith("SOURCE_CANCELLATION_")) {
      return BillingReplacementService.reconcileSourceCancellation(change.id);
    }
    if (change.type !== "UNSUPPORTED_METHOD_CANCELLATION") {
      assertRazorpayBillingWritesEnabled(change.organizationId);
    }
    if (change.provisioningIntentVersion === 2 && !change.replacementSubscriptionId
      && (change.providerMutationAdmittedAt || change.failureCategory === MANUAL_REVIEW_CATEGORY)) {
      return BillingReplacementService.reconcileProvisioning(change.id);
    }
    const subscription = change.organizationSubscription;
    if (!subscription
      || subscription.organizationId !== change.organizationId
      || subscription.currentOrganizationId !== change.organizationId) {
      throw new BillingMutationSourceChangedError();
    }
    const providerMode = resolveRazorpayMode();
    if (subscription.providerMode !== providerMode) {
      throw new Error(
        `Subscription provider mode ${subscription.providerMode} cannot be reconciled in ${providerMode} mode`
      );
    }

    const retryLeaseToken = crypto.randomUUID();
    const retryStartedAt = new Date();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUnique({
        where: { id: change.organizationId },
        select: { billingMutationLeaseToken: true, billingMutationLeaseUntil: true },
      });
      if (!organization) throw new Error("Organization not found");
      if (organization.billingMutationLeaseToken
        || (organization.billingMutationLeaseUntil
          && organization.billingMutationLeaseUntil > retryStartedAt)) {
        throw new BillingChangeInProgressError(change.id);
      }
      const current = await tx.organizationBillingChange.findUnique({ where: { id: change.id } });
      if (!current || current.status !== "FAILED" || current.updatedAt.getTime() !== change.updatedAt.getTime()) {
        throw new Error("Failed billing change changed before retry reconciliation");
      }
      await tx.organization.update({
        where: { id: change.organizationId },
        data: {
          billingMutationLeaseToken: retryLeaseToken,
          billingMutationLeaseUntil: new Date(retryStartedAt.getTime() + LEASE_MS),
        },
      });
    });

    let provider: RazorpaySubscription;
    try {
      provider = await getRazorpayClient().fetchSubscription(subscription.razorpaySubscriptionId);
      assertProviderMutationResponse(provider);
    } catch (error) {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
        `;
        const current = await tx.organization.findUnique({
          where: { id: change.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (current?.billingMutationLeaseToken !== retryLeaseToken) return;
        const failureCode = isScheduledUndoFailureCode(change.failureCode)
          ? SCHEDULED_UNDO_RECONCILIATION_FAILED_CODE
          : "PROVIDER_RECONCILIATION_FAILED";
        const persisted = await tx.organizationBillingChange.updateMany({
          where: { id: change.id, status: "FAILED", updatedAt: change.updatedAt },
          data: {
            failureCategory: MANUAL_REVIEW_CATEGORY,
            failureCode,
            resolvedAt: null,
            lastError: error instanceof Error
              ? `Provider reconciliation failed: ${error.message}`
              : "Provider reconciliation failed",
          },
        });
        if (persisted.count === 1) {
          await recordBillingMutationAudit(tx, {
            changeId: change.id,
            organizationId: change.organizationId,
            organizationSubscriptionId: change.organizationSubscriptionId,
            attemptCount: change.attemptCount,
            outcome: "MANUAL_REVIEW_RETAINED",
            failureCode,
          });
        }
        await releaseLease(tx, change.organizationId, retryLeaseToken);
      });
      throw new BillingManualReviewRequiredError(
        change.id,
        "Provider reconciliation is unavailable; manual billing review is still required"
      );
    }

    if (isScheduledUndoFailureCode(change.failureCode)) {
      if (!providerConfirmsScheduledUndoComplete(subscription, provider)) {
        const scheduledChangeStillPending = providerConfirmsScheduledChangeStillPending(
          subscription,
          provider
        );
        await prisma.$transaction(async tx => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
          `;
          const current = await tx.organization.findUnique({
            where: { id: change.organizationId },
            select: { billingMutationLeaseToken: true },
          });
          if (current?.billingMutationLeaseToken !== retryLeaseToken) return;
          const failureCode = scheduledChangeStillPending
            ? SCHEDULED_UNDO_OUTCOME_UNKNOWN_CODE
            : SCHEDULED_UNDO_RECONCILIATION_FAILED_CODE;
          const persisted = await tx.organizationBillingChange.updateMany({
            where: { id: change.id, status: "FAILED", updatedAt: change.updatedAt },
            data: {
              failureCategory: MANUAL_REVIEW_CATEGORY,
              failureCode,
              resolvedAt: null,
              lastError: scheduledChangeStillPending
                ? "The earlier scheduled-change undo outcome remains ambiguous; no second provider undo was submitted"
                : "Provider state does not safely confirm the scheduled-change undo",
            },
          });
          if (persisted.count === 1) {
            await recordBillingMutationAudit(tx, {
              changeId: change.id,
              organizationId: change.organizationId,
              organizationSubscriptionId: change.organizationSubscriptionId,
              attemptCount: change.attemptCount,
              outcome: "MANUAL_REVIEW_RETAINED",
              failureCode,
            });
          }
          await releaseLease(tx, change.organizationId, retryLeaseToken);
        });
        throw new BillingManualReviewRequiredError(
          change.id,
          "Scheduled-change undo remains ambiguous; no provider mutation was submitted"
        );
      }

      let undone: OrganizationBillingChange;
      try {
        undone = await prisma.$transaction(async tx => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
          `;
          const organization = await tx.organization.findUnique({
            where: { id: change.organizationId },
            select: { billingMutationLeaseToken: true },
          });
          if (organization?.billingMutationLeaseToken !== retryLeaseToken) {
            throw new Error("Scheduled-change undo reconciliation lease was lost");
          }
          const updated = await tx.organizationBillingChange.updateMany({
            where: { id: change.id, status: "FAILED", updatedAt: change.updatedAt },
            data: {
              status: "UNDONE",
              operationStatus: "ABANDONED",
              undoneAt: retryStartedAt,
              failedAt: null,
              resolvedAt: retryStartedAt,
              failureCategory: null,
              failureCode: null,
              lastError: null,
            },
          });
          if (updated.count !== 1) {
            throw new Error("Scheduled-change undo moved during provider reconciliation");
          }
          if (change.type === "BRANCH_REMOVAL" && change.branchId) {
            const restored = await tx.branch.updateMany({
              where: {
                id: change.branchId,
                organizationId: change.organizationId,
                billingStatus: "REMOVAL_SCHEDULED",
              },
              data: { billingStatus: "ACTIVE" },
            });
            if (restored.count !== 1) {
              throw new Error("Branch state changed during provider-confirmed undo reconciliation");
            }
          }
          await tx.organizationSubscription.update({
            where: { id: subscription.id },
            data: {
              lastReconciledAt: retryStartedAt,
              cancelAtCycleEnd: change.type === "CANCELLATION" ? false : undefined,
              cancellationRequestedAt: change.type === "CANCELLATION" ? null : undefined,
              cancellationScheduledAt: change.type === "CANCELLATION" ? null : undefined,
            },
          });
          await recordBillingMutationAudit(tx, {
            changeId: change.id,
            organizationId: change.organizationId,
            organizationSubscriptionId: change.organizationSubscriptionId,
            attemptCount: change.attemptCount,
            outcome: "PROVIDER_STATE_ADOPTED",
          });
          await releaseLease(tx, change.organizationId, retryLeaseToken);
          return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
        });
      } catch (error) {
        await prisma.$transaction(async tx => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
          `;
          const organization = await tx.organization.findUnique({
            where: { id: change.organizationId },
            select: { billingMutationLeaseToken: true },
          });
          if (organization?.billingMutationLeaseToken !== retryLeaseToken) return;
          await tx.organizationBillingChange.updateMany({
            where: { id: change.id, status: "FAILED", updatedAt: change.updatedAt },
            data: {
              failureCategory: MANUAL_REVIEW_CATEGORY,
              failureCode: SCHEDULED_UNDO_RECONCILIATION_FAILED_CODE,
              resolvedAt: null,
              lastError: error instanceof Error
                ? `Scheduled-change undo reconciliation could not be finalized: ${error.message}`
                : "Scheduled-change undo reconciliation could not be finalized",
            },
          });
          await releaseLease(tx, change.organizationId, retryLeaseToken);
        });
        throw new BillingManualReviewRequiredError(
          change.id,
          "Scheduled-change undo was confirmed but local reconciliation could not be finalized"
        );
      }
      await this.replayAfterScheduledUndo(undone);
      return undone;
    }

    const definitelyRejected = SAFE_RETRY_FAILURE_CATEGORIES.has(change.failureCategory ?? "");
    const reconciliationExecution = providerExecutionForManualReconciliation(
      change,
      subscription,
      provider
    );
    if (!definitelyRejected
      && reconciliationExecution
      && providerConfirmsExactMutationTarget(reconciliationExecution)) {
      try {
        return await this.finalizeProviderMutation(
          change,
          reconciliationExecution,
          retryLeaseToken,
          { status: "FAILED", updatedAt: change.updatedAt },
          retryStartedAt,
          "PROVIDER_STATE_ADOPTED"
        );
      } catch (error) {
        await prisma.$transaction(async tx => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
          `;
          const organization = await tx.organization.findUnique({
            where: { id: change.organizationId },
            select: { billingMutationLeaseToken: true },
          });
          if (organization?.billingMutationLeaseToken !== retryLeaseToken) return;
          await tx.organizationBillingChange.updateMany({
            where: { id: change.id, status: "FAILED", updatedAt: change.updatedAt },
            data: {
              failureCategory: MANUAL_REVIEW_CATEGORY,
              failureCode: "PROVIDER_RECONCILIATION_FINALIZATION_FAILED",
              resolvedAt: null,
              lastError: error instanceof Error
                ? `Provider reconciliation could not be finalized: ${error.message}`
                : "Provider reconciliation could not be finalized",
            },
          });
          await releaseLease(tx, change.organizationId, retryLeaseToken);
        });
        throw new BillingManualReviewRequiredError(
          change.id,
          "Provider state was confirmed but local reconciliation could not be finalized"
        );
      }
    }
    const sourceUnchanged = providerStillMatchesMutationSource(change, subscription, provider);
    if (!definitelyRejected || !sourceUnchanged) {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
        `;
        const current = await tx.organization.findUnique({
          where: { id: change.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (current?.billingMutationLeaseToken !== retryLeaseToken) return;
        const failureCode = sourceUnchanged
          ? AMBIGUOUS_PROVIDER_FAILURE_CODE
          : "PROVIDER_STATE_DIFFERS_FROM_MUTATION_SOURCE";
        const persisted = await tx.organizationBillingChange.updateMany({
          where: { id: change.id, status: "FAILED", updatedAt: change.updatedAt },
          data: {
            failureCategory: MANUAL_REVIEW_CATEGORY,
            failureCode,
            resolvedAt: null,
            lastError: sourceUnchanged
              ? "The earlier provider mutation outcome remains ambiguous and cannot be resubmitted automatically"
              : "Provider state changed before retry; manual billing reconciliation is required",
          },
        });
        if (persisted.count === 1) {
          await recordBillingMutationAudit(tx, {
            changeId: change.id,
            organizationId: change.organizationId,
            organizationSubscriptionId: change.organizationSubscriptionId,
            attemptCount: change.attemptCount,
            outcome: "MANUAL_REVIEW_RETAINED",
            failureCode,
          });
        }
        await releaseLease(tx, change.organizationId, retryLeaseToken);
      });
      throw new BillingManualReviewRequiredError(change.id);
    }

    await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUnique({
        where: { id: change.organizationId },
        select: { billingMutationLeaseToken: true },
      });
      if (organization?.billingMutationLeaseToken !== retryLeaseToken) {
        throw new Error("Billing mutation reconciliation lease was lost");
      }
      const requeued = await tx.organizationBillingChange.updateMany({
        where: { id: change.id, status: "FAILED", updatedAt: change.updatedAt },
        data: {
          status: "QUEUED",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          failedAt: null,
          resolvedAt: null,
          failureCategory: null,
          failureCode: null,
          lastError: null,
        },
      });
      if (requeued.count !== 1) {
        throw new Error("Failed billing change changed during retry reconciliation");
      }
      await releaseLease(tx, change.organizationId, retryLeaseToken);
    });
    return this.processNext(change.organizationId);
  }

  /**
   * Cancels a provider-scheduled change under the same organization lease used
   * by every other subscription mutation. The provider call is deliberately
   * outside the database transaction. Once the undo is durably finalized, the
   * next queued intent is replayed in FIFO order.
   */
  static async undoScheduledProviderChange(changeId: string, now = new Date()) {
    const snapshot = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      include: { organizationSubscription: true },
    });
    if (snapshot?.status === "PROCESSING") {
      throw new BillingChangeInProgressError(
        snapshot.id,
        "The scheduled provider change is already being undone"
      );
    }
    if (!snapshot || snapshot.status !== "SCHEDULED") {
      throw new Error("Scheduled billing change not found");
    }
    if (snapshot.replacementSubscriptionId) {
      const change = await BillingReplacementService.undoReplacement(changeId, now);
      return { change, replayed: null };
    }
    const subscription = snapshot.organizationSubscription;
    if (!subscription) throw new Error("Subscription not found for scheduled billing change");
    assertRazorpayBillingWritesEnabled(snapshot.organizationId);
    const providerMode = resolveRazorpayMode();
    if (subscription.providerMode !== providerMode) {
      throw new Error(
        `Subscription provider mode ${subscription.providerMode} cannot be mutated in ${providerMode} mode`
      );
    }
    if (snapshot.type !== "CANCELLATION" && subscription.providerPaymentMethod !== "CARD") {
      throw new Error("UPI AutoPay and eMandate billing changes require a replacement mandate");
    }

    const leaseToken = crypto.randomUUID();
    const claimed = await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUnique({
        where: { id: snapshot.organizationId },
        select: { billingMutationLeaseToken: true, billingMutationLeaseUntil: true },
      });
      if (!organization) throw new Error("Organization not found");
      if (organization.billingMutationLeaseToken
        || (organization.billingMutationLeaseUntil && organization.billingMutationLeaseUntil > now)) {
        throw new BillingChangeInProgressError(
          changeId,
          "Another billing operation is still processing"
        );
      }
      const current = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: { organizationSubscription: true },
      });
      if (!current || current.status !== "SCHEDULED") {
        throw new Error("Scheduled billing change is no longer undoable");
      }
      if (current.organizationId !== snapshot.organizationId
        || current.organizationSubscriptionId !== subscription.id
        || current.organizationSubscription?.razorpaySubscriptionId
          !== subscription.razorpaySubscriptionId) {
        throw new Error("Scheduled billing change subscription changed before undo");
      }
      const retryingUndo = current.failureCategory != null
        || (current.failureCode?.startsWith("SCHEDULED_UNDO_") ?? false);
      await tx.organization.update({
        where: { id: snapshot.organizationId },
        data: {
          billingMutationLeaseToken: leaseToken,
          billingMutationLeaseUntil: new Date(now.getTime() + LEASE_MS),
        },
      });
      const updated = await tx.organizationBillingChange.updateMany({
        where: {
          id: current.id,
          organizationId: snapshot.organizationId,
          status: "SCHEDULED",
          updatedAt: current.updatedAt,
        },
        data: {
          status: "PROCESSING",
          attemptCount: { increment: 1 },
          processingStartedAt: now,
          failedAt: null,
          resolvedAt: null,
          failureCategory: null,
          failureCode: retryingUndo
            ? SCHEDULED_UNDO_RETRY_PROCESSING_CODE
            : SCHEDULED_UNDO_PROCESSING_CODE,
          lastError: null,
        },
      });
      if (updated.count !== 1) {
        throw new BillingChangeInProgressError(
          current.id,
          "The scheduled billing change moved while its undo was being claimed"
        );
      }
      return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: current.id } });
    });

    let undone: OrganizationBillingChange;
    let providerCallStarted = false;
    let providerResponseReceived = false;
    try {
      await this.renewLeaseForProviderMutation(snapshot.organizationId, leaseToken);
      if (claimed.failureCode === SCHEDULED_UNDO_RETRY_PROCESSING_CODE) {
        let reconciled: RazorpaySubscription;
        try {
          reconciled = await getRazorpayClient().fetchSubscription(
            subscription.razorpaySubscriptionId
          );
          assertProviderMutationResponse(reconciled);
        } catch (error) {
          throw new ScheduledUndoReconciliationError(
            error instanceof Error
              ? `Scheduled-change undo reconciliation failed: ${error.message}`
              : "Scheduled-change undo reconciliation failed"
          );
        }
        if (providerConfirmsScheduledUndoComplete(subscription, reconciled)) {
          undone = await this.finalizeScheduledProviderUndo(
            claimed,
            subscription,
            reconciled,
            leaseToken,
            new Date()
          );
          return this.replayAfterScheduledUndo(undone);
        }
        if (!providerConfirmsScheduledChangeStillPending(subscription, reconciled)) {
          throw new ScheduledUndoReconciliationError(
            "Provider state does not prove that the original scheduled change is still pending"
          );
        }
        await this.renewLeaseForProviderMutation(snapshot.organizationId, leaseToken);
      }
      providerCallStarted = true;
      const providerSubscription = await executeBillingProviderAction({ organizationId: claimed.organizationId, change: claimed, leaseToken, purpose: "UNDO_SCHEDULE", command: { method: "cancelScheduledChanges", args: [subscription.razorpaySubscriptionId] } });
      providerResponseReceived = true;
      assertProviderMutationResponse(providerSubscription);
      if (!providerConfirmsScheduledUndoComplete(subscription, providerSubscription)) {
        throw new Error("Razorpay response does not confirm that the scheduled change was undone");
      }
      undone = await this.finalizeScheduledProviderUndo(
        claimed,
        subscription,
        providerSubscription,
        leaseToken,
        new Date()
      );
    } catch (error) {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUnique({
          where: { id: snapshot.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (organization?.billingMutationLeaseToken !== leaseToken) return;
        const reconciliationFailed = error instanceof ScheduledUndoReconciliationError;
        const ambiguousProviderOutcome = reconciliationFailed
          || providerResponseReceived
          || (providerCallStarted && !isDefinitelyRejectedProviderError(error));
        const failedAt = new Date();
        const failureCode = reconciliationFailed
          ? SCHEDULED_UNDO_RECONCILIATION_FAILED_CODE
          : ambiguousProviderOutcome
            ? SCHEDULED_UNDO_OUTCOME_UNKNOWN_CODE
            : providerCallStarted
              ? SCHEDULED_UNDO_PROVIDER_REJECTED_CODE
              : SCHEDULED_UNDO_PRE_PROVIDER_FAILURE_CODE;
        const persisted = await tx.organizationBillingChange.updateMany({
          where: {
            id: claimed.id,
            status: "PROCESSING",
            attemptCount: claimed.attemptCount,
            processingStartedAt: claimed.processingStartedAt,
          },
          data: {
            status: ambiguousProviderOutcome ? "FAILED" : "SCHEDULED",
            operationStatus: ambiguousProviderOutcome ? "FAILED" : "SCHEDULED",
            failedAt,
            resolvedAt: ambiguousProviderOutcome ? null : failedAt,
            failureCategory: ambiguousProviderOutcome
              ? MANUAL_REVIEW_CATEGORY
              : providerCallStarted
                ? DEFINITE_PROVIDER_FAILURE_CATEGORY
                : PRE_PROVIDER_FAILURE_CATEGORY,
            failureCode,
            lastError: error instanceof Error ? error.message : "Scheduled-change undo failed",
          },
        });
        if (persisted.count === 1 && ambiguousProviderOutcome) {
          await recordBillingMutationAudit(tx, {
            changeId: claimed.id,
            organizationId: claimed.organizationId,
            organizationSubscriptionId: claimed.organizationSubscriptionId,
            attemptCount: claimed.attemptCount,
            outcome: "MANUAL_REVIEW_REQUIRED",
            failureCode,
          });
        }
        await releaseLease(tx, snapshot.organizationId, leaseToken);
      });
      throw error;
    }
    return this.replayAfterScheduledUndo(undone);
  }

  private static async finalizeScheduledProviderUndo(
    claimed: OrganizationBillingChange,
    subscription: {
      id: string;
      razorpaySubscriptionId: string;
      razorpayPlanId: string;
      quantity: number;
    },
    providerSubscription: RazorpaySubscription,
    leaseToken: string,
    finalizedAt: Date
  ) {
    return prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${claimed.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUnique({
        where: { id: claimed.organizationId },
        select: { billingMutationLeaseToken: true },
      });
      if (organization?.billingMutationLeaseToken !== leaseToken) {
        throw new Error("Billing mutation lease was lost while undoing scheduled change");
      }
      if (!providerConfirmsScheduledUndoComplete(subscription, providerSubscription)) {
        throw new Error("Provider state no longer confirms the scheduled change undo");
      }
      const updated = await tx.organizationBillingChange.updateMany({
        where: {
          id: claimed.id,
          organizationId: claimed.organizationId,
          status: "PROCESSING",
          attemptCount: claimed.attemptCount,
          processingStartedAt: claimed.processingStartedAt,
        },
        data: {
          status: "UNDONE",
          operationStatus: "ABANDONED",
          undoneAt: finalizedAt,
          failedAt: null,
          resolvedAt: finalizedAt,
          failureCategory: null,
          failureCode: null,
          lastError: null,
        },
      });
      if (updated.count !== 1) {
        throw new Error("Scheduled billing change attempt was superseded before undo finalization");
      }
      if (claimed.type === "BRANCH_REMOVAL" && claimed.branchId) {
        const restored = await tx.branch.updateMany({
          where: {
            id: claimed.branchId,
            organizationId: claimed.organizationId,
            billingStatus: "REMOVAL_SCHEDULED",
          },
          data: { billingStatus: "ACTIVE" },
        });
        if (restored.count !== 1) {
          throw new Error("Branch state changed before provider-confirmed undo finalization");
        }
      }
      await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          lastReconciledAt: finalizedAt,
          cancelAtCycleEnd: claimed.type === "CANCELLATION" ? false : undefined,
          cancellationRequestedAt: claimed.type === "CANCELLATION" ? null : undefined,
          cancellationScheduledAt: claimed.type === "CANCELLATION" ? null : undefined,
        },
      });
      await releaseLease(tx, claimed.organizationId, leaseToken);
      await confirmReconciledBillingProviderAction(tx, { organizationId: claimed.organizationId,
        identity: claimed.id, purpose: "UNDO_SCHEDULE", provider: providerSubscription });
      return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: claimed.id } });
    });
  }

  private static async replayAfterScheduledUndo(undone: OrganizationBillingChange) {
    try {
      const replayed = await this.processNext(undone.organizationId);
      return { change: undone, replayed };
    } catch (error) {
      // The undo is already provider-confirmed and durable. A later replay can
      // fail independently and is itself persisted as FAILED for retry; do not
      // make the completed undo appear unsuccessful to the caller.
      const replayed = await prisma.organizationBillingChange.findFirst({
        where: {
          organizationId: undone.organizationId,
          sequence: { gt: undone.sequence },
          status: "FAILED",
        },
        orderBy: { sequence: "asc" },
      });
      return {
        change: undone,
        replayed,
        replayError: error instanceof Error ? error.message : "Queued billing replay failed",
      };
    }
  }

  private static async renewLeaseForProviderMutation(
    organizationId: string,
    leaseToken: string
  ) {
    const renewed = await prisma.organization.updateMany({
      where: { id: organizationId, billingMutationLeaseToken: leaseToken },
      data: { billingMutationLeaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (renewed.count !== 1) {
      throw new Error("Billing mutation lease was lost before provider mutation");
    }
  }

  private static async executeProviderMutation(
    change: OrganizationBillingChange,
    leaseToken: string,
    onProviderCallStarted: () => void
  ) {
    if (!change.organizationSubscriptionId) {
      throw new BillingMutationSourceChangedError();
    }
    const subscription = await prisma.organizationSubscription.findUnique({
      where: { id: change.organizationSubscriptionId },
      include: { billingOffer: true },
    });
    if (!subscription
      || subscription.organizationId !== change.organizationId
      || subscription.currentOrganizationId !== change.organizationId) {
      throw new BillingMutationSourceChangedError();
    }
    const providerMode = resolveRazorpayMode();
    if (subscription.providerMode !== providerMode) {
      throw new Error(
        `Subscription provider mode ${subscription.providerMode} cannot be mutated in ${providerMode} mode`
      );
    }
    if (change.type !== "UNSUPPORTED_METHOD_CANCELLATION") {
      assertRazorpayBillingWritesEnabled(change.organizationId);
    }
    const razorpay = getRazorpayClient();
    const intendedQuantity = change.toQuantity ?? subscription.quantity;
    let target = {
      providerPlanId: subscription.razorpayPlanId,
      plan: subscription.plan,
      amountSubunits: subscription.amountSubunits,
      currency: subscription.currency,
      period: subscription.period,
      interval: subscription.interval,
    };
    let commercialIntent;
    if (change.commercialIntentVersion != null) {
      commercialIntent = readCommercialIntentSnapshot(change, { requireBoundSubscription: true });
      if (commercialIntent.authorizedProviderMode !== providerMode
        || commercialIntent.authorizedRazorpaySubscriptionId
          !== subscription.razorpaySubscriptionId
        || (change.toPlan != null && change.toPlan !== commercialIntent.authorizedPlan)
        || (change.toQuantity != null
          && change.toQuantity !== commercialIntent.authorizedQuantity)) {
        throw new Error("The immutable commercial authorization does not match this mutation");
      }
      target = {
        providerPlanId: commercialIntent.authorizedRazorpayPlanId!,
        plan: commercialIntent.authorizedPlan,
        amountSubunits: commercialIntent.authorizedUnitAmountSubunits,
        currency: commercialIntent.authorizedCurrency,
        period: commercialIntent.authorizedPeriod,
        interval: commercialIntent.authorizedInterval,
      };
    } else if (change.toPlan) {
      const plan = getBillingPlan(change.toPlan);
      if (!plan?.amount) throw new Error("Target billing plan is not available for subscriptions");
      const mapping = await ensureRazorpayPlanCatalogEntry({
        plan: change.toPlan,
        name: plan.name,
        description: plan.description,
        amount: plan.amount,
        currency: plan.currency,
        period: plan.period,
        interval: plan.interval,
      });
      if (mapping.providerMode !== providerMode) {
        throw new Error("Razorpay plan mapping belongs to the wrong provider mode");
      }
      target = {
        providerPlanId: mapping.razorpayPlanId,
        plan: mapping.plan,
        amountSubunits: mapping.amountSubunits,
        currency: mapping.currency,
        period: mapping.period,
        interval: mapping.interval,
      };
    }
    if (!commercialIntent) {
      commercialIntent = buildCommercialIntentSnapshot({
        providerMode,
        razorpaySubscriptionId: subscription.razorpaySubscriptionId,
        sourceRazorpayPlanId: subscription.razorpayPlanId,
        razorpayPlanId: target.providerPlanId,
        plan: target.plan,
        quantity: intendedQuantity,
        unitAmountSubunits: target.amountSubunits,
        currency: target.currency,
        period: target.period,
        interval: target.interval,
        offer: subscription.billingOffer,
        capturedAt: new Date(),
      });
      change = await captureProcessingCommercialIntent({
        change,
        leaseToken,
        intent: commercialIntent,
      });
    }
    const targetQuantity = commercialIntent.authorizedQuantity;

    if (change.type === "UNSUPPORTED_METHOD_CANCELLATION") {
      await this.renewLeaseForProviderMutation(change.organizationId, leaseToken);
      onProviderCallStarted();
      const provider = await executeBillingProviderAction({ organizationId: change.organizationId, change, leaseToken, purpose: "MUTATE", command: { method: "cancelSubscription", args: [subscription.razorpaySubscriptionId, {
        cancel_at_cycle_end: false,
      }] } });
      return {
        provider,
        subscriptionId: subscription.razorpaySubscriptionId,
        sourcePlanId: subscription.razorpayPlanId,
        sourceQuantity: subscription.quantity,
        targetPlanId: subscription.razorpayPlanId,
        targetQuantity: subscription.quantity,
        scheduleChangeAt: "now" as const,
        cancellation: true,
      };
    }
    if (change.type === "CANCELLATION") {
      const immediate = subscription.status === "CREATED" || subscription.status === "AUTHENTICATED";
      await this.renewLeaseForProviderMutation(change.organizationId, leaseToken);
      onProviderCallStarted();
      const provider = await executeBillingProviderAction({ organizationId: change.organizationId, change, leaseToken, purpose: "MUTATE", command: { method: "cancelSubscription", args: [subscription.razorpaySubscriptionId, {
        cancel_at_cycle_end: !immediate,
      }] } });
      return {
        provider,
        subscriptionId: subscription.razorpaySubscriptionId,
        sourcePlanId: subscription.razorpayPlanId,
        sourceQuantity: subscription.quantity,
        targetPlanId: subscription.razorpayPlanId,
        targetQuantity: subscription.quantity,
        scheduleChangeAt: immediate ? "now" as const : "cycle_end" as const,
        cancellation: true,
      };
    }
    if (subscription.providerPaymentMethod !== "CARD") {
      throw new Error("UPI AutoPay and eMandate billing changes require a replacement mandate");
    }

    // Catalog provisioning has its own durable lease and may take longer than
    // a normal provider request. Refresh the organization lease immediately
    // before the subscription mutation so deadline recovery cannot overlap it.
    await this.renewLeaseForProviderMutation(change.organizationId, leaseToken);

    onProviderCallStarted();
    const scheduleChangeAt = IMMEDIATE_TYPES.has(change.type) ? "now" as const : "cycle_end" as const;
    const provider = await executeBillingProviderAction({ organizationId: change.organizationId, change, leaseToken, purpose: "MUTATE", command: { method: "updateSubscription", args: [subscription.razorpaySubscriptionId, {
      plan_id: change.toPlan ? target.providerPlanId : undefined,
      quantity: change.toQuantity != null ? targetQuantity : undefined,
      start_at: change.type === "TRIAL_SUBSCRIPTION_UPDATE"
        ? timestamp(subscription.providerStartAt)
        : undefined,
      schedule_change_at: scheduleChangeAt,
      customer_notify: true,
    }] } });
    return {
      provider,
      subscriptionId: subscription.razorpaySubscriptionId,
      sourcePlanId: subscription.razorpayPlanId,
      sourceQuantity: subscription.quantity,
      targetPlanId: target.providerPlanId,
      targetQuantity,
      scheduleChangeAt,
      cancellation: false,
    };
  }
}
