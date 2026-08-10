import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getRazorpayClient, resolveRazorpayMode } from "@/lib/razorpay";
import {
  areRazorpayMultiMethodSubscriptionsEnabled,
  areRazorpayBillingWritesEnabled,
  assertRazorpayBillingWritesEnabled,
} from "@/lib/billingFeature";
import { getBillingPlan } from "@/lib/billingPlans";
import { ensureRazorpayPlanCatalogEntry } from "@/services/razorpayPlanCatalog.service";
import { BillingReplacementService } from "@/services/billingReplacement.service";
import { isReplacementMutationEligible } from "@/services/billingReplacementPolicy";
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

    try {
      const source = await prisma.organizationSubscription.findUnique({
        where: { currentOrganizationId: organizationId },
        select: { providerPaymentMethod: true },
      });
      if (source
        && areRazorpayMultiMethodSubscriptionsEnabled()
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
      const result = await this.executeProviderMutation(claimed, leaseToken);
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
        `;
        const current = await tx.organization.findUnique({ where: { id: organizationId } });
        if (current?.billingMutationLeaseToken !== leaseToken) {
          throw new Error("Billing mutation lease was lost");
        }

        const cancellationType = claimed.type === "CANCELLATION"
          || claimed.type === "UNSUPPORTED_METHOD_CANCELLATION";
        const cancellationScheduled = claimed.type === "CANCELLATION"
          && !["cancelled", "completed", "expired"].includes(result.status.toLowerCase());
        const scheduled = (!IMMEDIATE_TYPES.has(claimed.type) && claimed.type !== "CANCELLATION")
          || cancellationScheduled;
        const awaitingPayment = ["PLAN_UPGRADE", "QUANTITY_INCREASE", "BRANCH_REACTIVATION"]
          .includes(claimed.type);
        const status = scheduled ? "SCHEDULED" : awaitingPayment ? "AWAITING_PAYMENT" : "APPLIED";
        const updated = await tx.organizationBillingChange.update({
          where: { id: claimed.id },
          data: {
            status,
            operationStatus: status === "SCHEDULED"
              ? "SCHEDULED"
              : status === "APPLIED"
                ? "APPLIED"
                : "AWAITING_PROVIDER_CONFIRMATION",
            appliedAt: status === "APPLIED" ? new Date() : null,
            providerConfirmedAt: status === "APPLIED" ? new Date() : null,
            resolvedAt: status === "APPLIED" ? new Date() : null,
          },
        });
        const providerPlan = claimed.type === "TRIAL_SUBSCRIPTION_UPDATE"
          ? await tx.saasRazorpayPlan.findFirst({
              where: {
                razorpayPlanId: result.plan_id,
                providerMode: resolveRazorpayMode(),
              },
            })
          : null;
        await tx.organizationSubscription.update({
          where: { currentOrganizationId: organizationId },
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
            lastReconciledAt: new Date(),
            cancelAtCycleEnd: cancellationType ? cancellationScheduled : undefined,
            cancellationRequestedAt: cancellationType ? claimed.createdAt : undefined,
            cancellationScheduledAt: claimed.type === "CANCELLATION" ? claimed.effectiveAt : undefined,
            cancelledAt: cancellationType && !cancellationScheduled ? new Date() : undefined,
          },
        });
        await releaseLease(tx, organizationId, leaseToken);
        return updated;
      });
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
        await tx.organizationBillingChange.updateMany({
          where: { id: claimed.id, status: "PROCESSING" },
          data: {
            status: "FAILED",
            operationStatus: "FAILED",
            failedAt: new Date(),
            resolvedAt: new Date(),
            lastError: error instanceof Error ? error.message : "Provider mutation failed",
          },
        });
        await releaseLease(tx, organizationId, leaseToken);
      });
      throw error;
    }
  }

  static async retry(changeId: string) {
    const change = await prisma.organizationBillingChange.findUnique({ where: { id: changeId } });
    if (!change || change.status !== "FAILED") throw new Error("Failed billing change not found");
    if (change.type !== "UNSUPPORTED_METHOD_CANCELLATION") {
      assertRazorpayBillingWritesEnabled(change.organizationId);
    }
    await prisma.organizationBillingChange.update({
      where: { id: changeId },
      data: {
        status: "QUEUED",
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
        failedAt: null,
        resolvedAt: null,
        lastError: null,
      },
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
        return false;
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
      await tx.organization.update({
        where: { id: snapshot.organizationId },
        data: {
          billingMutationLeaseToken: leaseToken,
          billingMutationLeaseUntil: new Date(now.getTime() + LEASE_MS),
        },
      });
      return true;
    });
    if (!claimed) throw new Error("Another billing operation is still processing; retry shortly");

    let undone: OrganizationBillingChange;
    try {
      await this.renewLeaseForProviderMutation(snapshot.organizationId, leaseToken);
      const providerSubscription = await getRazorpayClient().cancelScheduledChanges(
        subscription.razorpaySubscriptionId
      );
      if (providerSubscription.id !== subscription.razorpaySubscriptionId) {
        throw new Error("Razorpay subscription mismatch while undoing scheduled change");
      }

      undone = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUnique({
          where: { id: snapshot.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (organization?.billingMutationLeaseToken !== leaseToken) {
          throw new Error("Billing mutation lease was lost while undoing scheduled change");
        }
        const updated = await tx.organizationBillingChange.updateMany({
          where: { id: changeId, organizationId: snapshot.organizationId, status: "SCHEDULED" },
          data: {
            status: "UNDONE",
            operationStatus: "ABANDONED",
            undoneAt: now,
            resolvedAt: now,
            lastError: null,
          },
        });
        if (updated.count !== 1) {
          throw new Error("Scheduled billing change was modified while undoing it");
        }
        await releaseLease(tx, snapshot.organizationId, leaseToken);
        return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: changeId } });
      });

    } catch (error) {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${snapshot.organizationId} FOR UPDATE
        `;
        await releaseLease(tx, snapshot.organizationId, leaseToken);
      });
      throw error;
    }

    try {
      const replayed = await this.processNext(snapshot.organizationId);
      return { change: undone, replayed };
    } catch (error) {
      // The undo is already provider-confirmed and durable. A later replay can
      // fail independently and is itself persisted as FAILED for retry; do not
      // make the completed undo appear unsuccessful to the caller.
      const replayed = await prisma.organizationBillingChange.findFirst({
        where: {
          organizationId: snapshot.organizationId,
          sequence: { gt: snapshot.sequence },
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
    leaseToken: string
  ) {
    const subscription = await prisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: change.organizationId },
    });
    if (!subscription) throw new Error("Subscription not found");
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
    if (change.type === "UNSUPPORTED_METHOD_CANCELLATION") {
      await this.renewLeaseForProviderMutation(change.organizationId, leaseToken);
      return razorpay.cancelSubscription(subscription.razorpaySubscriptionId, {
        cancel_at_cycle_end: false,
      });
    }
    if (change.type === "CANCELLATION") {
      const immediate = subscription.status === "CREATED" || subscription.status === "AUTHENTICATED";
      await this.renewLeaseForProviderMutation(change.organizationId, leaseToken);
      return razorpay.cancelSubscription(subscription.razorpaySubscriptionId, {
        cancel_at_cycle_end: !immediate,
      });
    }
    if (subscription.providerPaymentMethod !== "CARD") {
      throw new Error("UPI AutoPay and eMandate billing changes require a replacement mandate");
    }

    let mapping = null;
    if (change.toPlan) {
      const plan = getBillingPlan(change.toPlan);
      if (!plan?.amount) throw new Error("Target billing plan is not available for subscriptions");
      mapping = await ensureRazorpayPlanCatalogEntry({
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
    }

    // Catalog provisioning has its own durable lease and may take longer than
    // a normal provider request. Refresh the organization lease immediately
    // before the subscription mutation so deadline recovery cannot overlap it.
    await this.renewLeaseForProviderMutation(change.organizationId, leaseToken);

    return razorpay.updateSubscription(subscription.razorpaySubscriptionId, {
      plan_id: mapping?.razorpayPlanId,
      quantity: change.toQuantity ?? undefined,
      start_at: change.type === "TRIAL_SUBSCRIPTION_UPDATE"
        ? timestamp(subscription.providerStartAt)
        : undefined,
      schedule_change_at: IMMEDIATE_TYPES.has(change.type) ? "now" : "cycle_end",
      customer_notify: true,
    });
  }
}
