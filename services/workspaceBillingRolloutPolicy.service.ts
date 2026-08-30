import {
  BILLING_PAID_EVIDENCE_INCLUDE,
  resolveTrustedPaidThrough,
  type BillingPaidEvidenceSubscription,
} from "@/services/billingPaidEvidence.service";
import type { Prisma } from "@/app/generated/prisma/client";

/** Prevents a legacy-to-V2 rollout from carrying unbacked paid access forward. */
export function assertWorkspaceRolloutPaidEvidence(
  subscription: BillingPaidEvidenceSubscription,
  now: Date = new Date()
) {
  const trustedPaidThrough = resolveTrustedPaidThrough(subscription, now);
  if (subscription.paidThrough && !trustedPaidThrough) {
    throw new Error("stored paidThrough is not backed by exact settlement evidence");
  }
  if (["ACTIVE", "PENDING"].includes(subscription.status) && !trustedPaidThrough) {
    throw new Error("active paid access requires exact provider settlement evidence");
  }
  return trustedPaidThrough;
}

/** Re-reads every promotion guard while holding the organization mutation lock. */
export async function applyWorkspaceBillingPromotion(
  tx: Prisma.TransactionClient,
  organizationId: string,
  now: Date = new Date()
) {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
  `;
  const organization = await tx.organization.findUnique({
    where: { id: organizationId },
    include: {
      subscription: { include: BILLING_PAID_EVIDENCE_INCLUDE },
      _count: {
        select: { branches: { where: { billingStatus: { not: "ARCHIVED" } } } },
      },
    },
  });
  if (!organization) throw new Error(`Organization ${organizationId} was not found`);
  if (organization.billingModelVersion === "WORKSPACE_V2") {
    return { organizationId, unchanged: true, transitionId: null };
  }

  const subscription = organization.subscription;
  let trustedPaidThrough: Date | null = null;
  if (subscription) {
    trustedPaidThrough = assertWorkspaceRolloutPaidEvidence(subscription, now);
    if (subscription.providerPaymentMethod !== "CARD") {
      throw new Error(`${organizationId}: provider payment method must be confirmed as CARD`);
    }
    if (!subscription.lastReconciledAt) {
      throw new Error(`${organizationId}: provider subscription and invoices must be reconciled first`);
    }
  }

  let transitionId: string | null = null;
  if (subscription && subscription.quantity !== organization._count.branches) {
    const sequence = organization.billingMutationSequence + 1;
    await tx.organization.update({
      where: { id: organizationId },
      data: { billingMutationSequence: sequence },
    });
    const transition = await tx.organizationBillingChange.upsert({
      where: {
        idempotencyKey: `legacy-transition:${organizationId}:${organization._count.branches}`,
      },
      create: {
        organizationId,
        organizationSubscriptionId: subscription.id,
        sequence,
        idempotencyKey: `legacy-transition:${organizationId}:${organization._count.branches}`,
        type: "LEGACY_TRANSITION",
        fromPlan: subscription.plan,
        toPlan: subscription.plan,
        fromQuantity: subscription.quantity,
        toQuantity: organization._count.branches,
        effectiveAt: trustedPaidThrough,
      },
      update: {},
    });
    transitionId = transition.id;
  }
  await tx.organization.update({
    where: { id: organizationId },
    data: { billingModelVersion: "WORKSPACE_V2" },
  });
  return { organizationId, unchanged: false, transitionId };
}
