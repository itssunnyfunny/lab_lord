import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { BillingValidationError } from "@/lib/billingErrors";
import { OrganizationAccessNotFoundError } from "@/lib/organizationErrors";

const TRIAL_DAYS = 30;

function addTrialDays(start: Date) {
  return new Date(start.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

export class OwnerTrialService {
  static async startOnboardingTrial(
    tx: Prisma.TransactionClient,
    ownerId: string,
    organizationId: string,
    now = new Date()
  ) {
    const owner = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE
    `;
    if (owner.length === 0) throw new Error("Owner not found");

    const existing = await tx.ownerTrialGrant.findUnique({ where: { ownerId } });
    if (existing) return null;

    return tx.ownerTrialGrant.create({
      data: {
        ownerId,
        organizationId,
        source: "ONBOARDING",
        status: "ACTIVE",
        claimedAt: now,
        trialStartedAt: now,
        trialEndsAt: addTrialDays(now),
        consumedAt: now,
      },
    });
  }

  static async claimMigratedTrial(
    ownerId: string,
    organizationId: string,
    now = new Date()
  ) {
    return prisma.$transaction(async tx => {
      const owner = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE
      `;
      if (owner.length === 0) throw new Error("Owner not found");

      const organization = await tx.organization.findFirst({
        where: { id: organizationId, ownerId },
        select: {
          id: true,
          subscription: { select: { id: true } },
          _count: { select: { subscriptionHistory: true } },
        },
      });
      if (!organization) throw new OrganizationAccessNotFoundError();
      if (organization.subscription || organization._count.subscriptionHistory > 0) {
        throw new BillingValidationError("Only a never-billed organization can claim this trial");
      }

      const grant = await tx.ownerTrialGrant.findUnique({ where: { ownerId } });
      if (!grant || grant.source !== "MIGRATION" || grant.status !== "AVAILABLE") {
        throw new BillingValidationError("No migrated trial is available");
      }

      return tx.ownerTrialGrant.update({
        where: { id: grant.id },
        data: {
          organizationId,
          status: "ACTIVE",
          claimedAt: now,
          trialStartedAt: now,
          trialEndsAt: addTrialDays(now),
          consumedAt: now,
        },
      });
    });
  }

  static async expireDueTrials(now = new Date()) {
    return prisma.ownerTrialGrant.updateMany({
      where: { status: "ACTIVE", trialEndsAt: { lte: now } },
      data: { status: "EXPIRED" },
    });
  }
}

export { TRIAL_DAYS };
