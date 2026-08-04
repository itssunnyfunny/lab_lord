import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getRazorpayClient } from "@/lib/razorpay";
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
  return ["CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "CANCELLED", "COMPLETED", "EXPIRED"]
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
        if (duplicate.organizationId !== input.organizationId || duplicate.type !== input.type) {
          throw new Error("Idempotency key was already used for another billing operation");
        }
        return duplicate;
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
      if (organization.billingMutationLeaseUntil && organization.billingMutationLeaseUntil > now) {
        return null;
      }

      const failed = await tx.organizationBillingChange.findFirst({
        where: { organizationId, status: "FAILED" },
        orderBy: { sequence: "asc" },
      });
      const next = await tx.organizationBillingChange.findFirst({
        where: { organizationId, status: "QUEUED" },
        orderBy: { sequence: "asc" },
      });
      if (!next || (failed && failed.sequence < next.sequence)) return null;

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
      const result = await this.executeProviderMutation(claimed);
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
        `;
        const current = await tx.organization.findUnique({ where: { id: organizationId } });
        if (current?.billingMutationLeaseToken !== leaseToken) {
          throw new Error("Billing mutation lease was lost");
        }

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
          ? await tx.saasRazorpayPlan.findUnique({ where: { razorpayPlanId: result.plan_id } })
          : null;
        await tx.organizationSubscription.update({
          where: { organizationId },
          data: {
            plan: providerPlan?.plan,
            amount: providerPlan?.amount,
            amountSubunits: providerPlan?.amountSubunits,
            currency: providerPlan?.currency,
            period: providerPlan?.period,
            interval: providerPlan?.interval,
            razorpayPlanId: providerPlan?.razorpayPlanId,
            status: providerStatus(result.status) as never,
            quantity: result.quantity ?? undefined,
            currentStart: result.current_start ? new Date(result.current_start * 1000) : undefined,
            currentEnd: result.current_end ? new Date(result.current_end * 1000) : undefined,
            chargeAt: result.charge_at ? new Date(result.charge_at * 1000) : undefined,
            providerStartAt: result.start_at ? new Date(result.start_at * 1000) : undefined,
            authorizationExpiresAt: result.expire_by ? new Date(result.expire_by * 1000) : undefined,
            lastReconciledAt: new Date(),
            cancelAtCycleEnd: claimed.type === "CANCELLATION" ? cancellationScheduled : undefined,
            cancellationRequestedAt: claimed.type === "CANCELLATION" ? claimed.createdAt : undefined,
            cancellationScheduledAt: claimed.type === "CANCELLATION" ? claimed.effectiveAt : undefined,
            cancelledAt: claimed.type === "CANCELLATION" && !cancellationScheduled ? new Date() : undefined,
          },
        });
        await releaseLease(tx, organizationId, leaseToken);
        return updated;
      });
    } catch (error) {
      await prisma.$transaction(async tx => {
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

  private static async executeProviderMutation(change: OrganizationBillingChange) {
    const subscription = await prisma.organizationSubscription.findUnique({
      where: { organizationId: change.organizationId },
    });
    if (!subscription) throw new Error("Subscription not found");
    if (subscription.providerPaymentMethod !== "CARD") {
      throw new Error("V1 subscription changes require a card-authorized subscription");
    }

    const razorpay = getRazorpayClient();
    if (change.type === "CANCELLATION") {
      const immediate = subscription.status === "CREATED" || subscription.status === "AUTHENTICATED";
      return razorpay.cancelSubscription(subscription.razorpaySubscriptionId, {
        cancel_at_cycle_end: !immediate,
      });
    }

    const mapping = change.toPlan
      ? await prisma.saasRazorpayPlan.findFirst({
          where: { plan: change.toPlan, active: true },
          orderBy: { createdAt: "desc" },
        })
      : null;
    if (change.toPlan && !mapping) throw new Error("Active Razorpay plan mapping not found");

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
