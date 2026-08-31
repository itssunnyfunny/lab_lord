import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeBoundBillingOperation,
  installIsolatedBillingEnvironment,
  loadIsolatedBillingEnvironment,
  parseBillingOperationTargetArguments,
  sanitizeBillingOperationError,
  type BillingEnvironment,
} from "./billing-operation-target";

const OPERATION_SCOPE = "organizations";

export function workspaceRolloutOrganizationScopes(organizationIds: readonly string[]) {
  return organizationIds.length > 0
    ? {
      organization: { id: { in: [...organizationIds] } },
      branch: { organizationId: { in: [...organizationIds] } },
    }
    : { organization: {}, branch: {} };
}

function parsePromotionIds(argv: string[]) {
  const promoteArguments = argv.filter(argument => argument.startsWith("--promote="));
  if (promoteArguments.length > 1) throw new Error("--promote may be provided only once");
  return promoteArguments[0]
    ? promoteArguments[0]
      .slice("--promote=".length)
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
    : [];
}

export async function runWorkspaceBillingRollout(
  argv: string[],
  invocation: BillingEnvironment = process.env
) {
  const arguments_ = parseBillingOperationTargetArguments(argv, {
    expectedScope: OPERATION_SCOPE,
    additionalArgumentPrefixes: ["--promote="],
    invocation,
  });
  const promoteIds = parsePromotionIds(argv);
  const organizationScopes = workspaceRolloutOrganizationScopes(arguments_.organizationIds);
  if (
    arguments_.organizationIds.length > 0 &&
    promoteIds.some(organizationId => !arguments_.organizationIds.includes(organizationId))
  ) {
    throw new Error("Every --promote organization must be included in --organization-ids");
  }
  const isolatedEnvironment = loadIsolatedBillingEnvironment(arguments_.envFile, invocation);
  installIsolatedBillingEnvironment(isolatedEnvironment);

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

  async function readDatabaseIdentity() {
    const rows = await prisma.$queryRaw<Array<{ identity: string }>>`
      SELECT "identity"::TEXT AS "identity"
      FROM "BillingDatabaseIdentity"
      WHERE "id" = 1
    `;
    if (rows.length !== 1 || !rows[0]?.identity) {
      throw new Error("Unable to resolve the database-resident billing identity");
    }
    return rows[0].identity;
  }

  async function prepareMigratedTrialGrants() {
    const eligibleOwners = await prisma.user.findMany({
      where: {
        ownerTrialGrant: null,
        organizations: {
          some: {
            ...organizationScopes.organization,
            subscription: null,
            subscriptionHistory: { none: {} },
          },
        },
      },
      select: { id: true },
    });
    if (arguments_.apply && eligibleOwners.length > 0) {
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
      where: {
        ...organizationScopes.branch,
        billingStatus: "ACTIVE",
        billingActivatedAt: null,
      },
    });
    if (arguments_.apply && missing > 0) {
      const branches = await prisma.branch.findMany({
        where: {
          ...organizationScopes.branch,
          billingStatus: "ACTIVE",
          billingActivatedAt: null,
        },
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
    if (organization.billingModelVersion === "WORKSPACE_V2") {
      return { organizationId, unchanged: true };
    }

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

    if (!arguments_.apply) {
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
    const { targetBinding, result } = await executeBoundBillingOperation({
      arguments: arguments_,
      environment: isolatedEnvironment,
      expectedScope: OPERATION_SCOPE,
      readDatabaseIdentity,
      execute: async () => {
        const [eligibleTrialOwners, branchesToBackfill] = await Promise.all([
          prepareMigratedTrialGrants(),
          backfillBranchBillingState(),
        ]);
        const promotions = [];
        for (const organizationId of promoteIds) {
          promotions.push(await promoteOrganization(organizationId));
        }
        return { eligibleTrialOwners, branchesToBackfill, promotions };
      },
    });
    return {
      mode: arguments_.apply ? "apply" : "dry-run",
      targetBinding,
      ...result,
      note: arguments_.apply
        ? "Database preparation applied; no Razorpay mutation was sent."
        : "No database or Razorpay state was changed. Re-run with the exact target binding and --apply after reviewing.",
    };
  } finally {
    await prisma.$disconnect();
  }
}

function printUsage() {
  console.log(`Workspace billing rollout preparation

Dry run:
  pnpm exec tsx scripts/prepare-workspace-billing-rollout.ts [--scope=${OPERATION_SCOPE} --organization-ids=ORG_IDS] [--promote=ORG_IDS]

Apply (all target-binding flags are required):
  pnpm exec tsx scripts/prepare-workspace-billing-rollout.ts --apply --target=preview|production --expect-razorpay-mode=TEST|LIVE --expect-database-fingerprint=SHA256 --scope=${OPERATION_SCOPE} --organization-ids=ORG_IDS [--promote=ORG_IDS]

Set BILLING_ENV_FILE to select the isolated environment file.
Every query and write in apply mode is restricted to the explicit organization allowlist.`);
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    printUsage();
  } else {
    try {
      console.log(JSON.stringify(await runWorkspaceBillingRollout(argv), null, 2));
    } catch (error) {
      console.error(`Workspace billing rollout failed: ${sanitizeBillingOperationError(error)}`);
      process.exitCode = 1;
    }
  }
}
