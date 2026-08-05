import { config } from "dotenv";

config({ path: process.env.BILLING_ENV_FILE ?? ".env", override: false });

const { prisma } = await import("../lib/prisma");

const apply = process.argv.includes("--apply");
const promoteArgument = process.argv.find(argument => argument.startsWith("--promote="));
const promoteIds = promoteArgument
  ? promoteArgument.slice("--promote=".length).split(",").map(value => value.trim()).filter(Boolean)
  : [];

async function prepareMigratedTrialGrants() {
  const eligibleOwners = await prisma.user.findMany({
    where: {
      ownerTrialGrant: null,
      organizations: {
        some: {
          subscription: null,
          subscriptionHistory: { none: {} },
        },
      },
    },
    select: { id: true },
  });
  if (apply && eligibleOwners.length > 0) {
    await prisma.ownerTrialGrant.createMany({
      data: eligibleOwners.map(owner => ({
        ownerId: owner.id,
        source: "MIGRATION" as const,
        status: "AVAILABLE" as const,
      })),
      skipDuplicates: true,
    });
  }
  return eligibleOwners.length;
}

async function backfillBranchBillingState() {
  const missing = await prisma.branch.count({
    where: { billingStatus: "ACTIVE", billingActivatedAt: null },
  });
  if (apply && missing > 0) {
    const branches = await prisma.branch.findMany({
      where: { billingStatus: "ACTIVE", billingActivatedAt: null },
      select: { id: true, createdAt: true },
    });
    for (const branch of branches) {
      await prisma.branch.update({
        where: { id: branch.id },
        data: { billingActivatedAt: branch.createdAt },
      });
    }
  }
  return missing;
}

async function promoteOrganization(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      subscription: true,
      _count: { select: { branches: { where: { billingStatus: { not: "ARCHIVED" } } } } },
    },
  });
  if (!organization) throw new Error(`Organization ${organizationId} was not found`);
  if (organization.billingModelVersion === "WORKSPACE_V2") return { organizationId, unchanged: true };

  const subscription = organization.subscription;
  if (subscription) {
    if (subscription.providerPaymentMethod !== "CARD") {
      throw new Error(`${organizationId}: provider payment method must be confirmed as CARD`);
    }
    if (!subscription.lastReconciledAt) {
      throw new Error(`${organizationId}: provider subscription and invoices must be reconciled first`);
    }
    if (["ACTIVE", "PENDING"].includes(subscription.status) && !subscription.paidThrough) {
      throw new Error(`${organizationId}: active paid access requires provider-confirmed paidThrough`);
    }
  }

  if (!apply) {
    return {
      organizationId,
      unchanged: false,
      branchCount: organization._count.branches,
      providerQuantity: subscription?.quantity ?? null,
    };
  }

  return prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
    `;
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
          effectiveAt: subscription.currentEnd ?? subscription.paidThrough,
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
  });
}

try {
  const [eligibleTrialOwners, branchesToBackfill] = await Promise.all([
    prepareMigratedTrialGrants(),
    backfillBranchBillingState(),
  ]);
  const promotions = [];
  for (const organizationId of promoteIds) {
    promotions.push(await promoteOrganization(organizationId));
  }
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    eligibleTrialOwners,
    branchesToBackfill,
    promotions,
    note: apply
      ? "Database preparation applied; no Razorpay mutation was sent."
      : "No database or Razorpay state was changed. Re-run with --apply after reviewing.",
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
