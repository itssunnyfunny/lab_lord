import type { Prisma } from "@/app/generated/prisma/client";

export async function recordBillingMutationAudit(
  tx: Prisma.TransactionClient,
  input: {
    changeId: string;
    organizationId: string;
    organizationSubscriptionId: string | null;
    attemptCount: number;
    outcome: "MANUAL_REVIEW_REQUIRED" | "MANUAL_REVIEW_RETAINED" | "PROVIDER_STATE_ADOPTED";
    failureCode?: string | null;
  }
) {
  if (!input.organizationSubscriptionId) return;
  const subscription = await tx.organizationSubscription.findFirst({
    where: {
      id: input.organizationSubscriptionId,
      organizationId: input.organizationId,
    },
  });
  if (!subscription) return;
  const safeFailureCode = input.failureCode?.replace(/[^A-Z0-9_]/g, "_").slice(0, 80)
    ?? "NONE";
  const event = `billing_change:${input.outcome}:${safeFailureCode}`;
  const dedupeKey = [
    "billing-change",
    input.changeId,
    input.attemptCount,
    input.outcome,
    safeFailureCode,
  ].join(":");
  await tx.organizationSubscriptionHistory.upsert({
    where: { dedupeKey },
    create: {
      organizationId: input.organizationId,
      organizationSubscriptionId: subscription.id,
      razorpaySubscriptionId: subscription.razorpaySubscriptionId,
      plan: subscription.plan,
      fromStatus: subscription.status,
      toStatus: subscription.status,
      source: "SYSTEM",
      event,
      amountSubunits: subscription.amountSubunits,
      quantity: subscription.quantity,
      unitAmountSubunits: subscription.amountSubunits,
      totalAmountSubunits: subscription.amountSubunits * subscription.quantity,
      paidThrough: subscription.paidThrough,
      dedupeKey,
      currency: subscription.currency,
    },
    update: {},
  });
}
