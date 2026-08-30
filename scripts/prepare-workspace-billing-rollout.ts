import { config } from "dotenv";

config({ path: process.env.BILLING_ENV_FILE ?? ".env", override: false });

const [{ prisma }, {
  BILLING_PAID_EVIDENCE_INCLUDE,
}, {
  applyWorkspaceBillingPromotion,
  assertWorkspaceRolloutPaidEvidence,
}] = await Promise.all([
  import("../lib/prisma"),
  import("../services/billingPaidEvidence.service"),
  import("../services/workspaceBillingRolloutPolicy.service"),
]);

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
      subscription: { include: BILLING_PAID_EVIDENCE_INCLUDE },
      _count: { select: { branches: { where: { billingStatus: { not: "ARCHIVED" } } } } },
    },
  });
  if (!organization) throw new Error(`Organization ${organizationId} was not found`);
  if (organization.billingModelVersion === "WORKSPACE_V2") return { organizationId, unchanged: true };

  const subscription = organization.subscription;
  if (subscription) {
    assertWorkspaceRolloutPaidEvidence(subscription, new Date());
    if (subscription.providerPaymentMethod !== "CARD") {
      throw new Error(`${organizationId}: provider payment method must be confirmed as CARD`);
    }
    if (!subscription.lastReconciledAt) {
      throw new Error(`${organizationId}: provider subscription and invoices must be reconciled first`);
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
    return applyWorkspaceBillingPromotion(tx, organizationId, new Date());
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
