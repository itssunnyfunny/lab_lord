import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BillingDeadlineService } from "@/services/billingDeadline.service";
import { createBranch, createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("workspace billing deadlines", () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await disconnectDatabase(); });

  it("expires a trial and archives a provider-free scheduled branch at its boundary", async () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: organization.id, name: "Main" });
    const branch = await createBranch({ organizationId: organization.id, name: "Closing" });
    await testPrisma.branch.update({
      where: { id: branch.id },
      data: { billingStatus: "REMOVAL_SCHEDULED" },
    });
    await testPrisma.ownerTrialGrant.create({
      data: {
        ownerId: owner.id,
        organizationId: organization.id,
        source: "ONBOARDING",
        status: "ACTIVE",
        trialStartedAt: new Date("2026-08-03T00:00:00.000Z"),
        trialEndsAt: new Date("2026-09-02T00:00:00.000Z"),
        consumedAt: new Date("2026-08-03T00:00:00.000Z"),
      },
    });
    await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        branchId: branch.id,
        sequence: 1,
        idempotencyKey: "deadline-removal",
        type: "BRANCH_REMOVAL",
        status: "SCHEDULED",
        fromQuantity: 2,
        toQuantity: 1,
        effectiveAt: new Date("2026-09-02T00:00:00.000Z"),
      },
    });

    const result = await BillingDeadlineService.run(now);

    expect(result).toMatchObject({ expiredTrials: 1, archivedBranches: 1, errors: [] });
    await expect(testPrisma.ownerTrialGrant.findUniqueOrThrow({ where: { ownerId: owner.id } }))
      .resolves.toMatchObject({ status: "EXPIRED" });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "ARCHIVED", billingArchivedAt: now });
  });
});
