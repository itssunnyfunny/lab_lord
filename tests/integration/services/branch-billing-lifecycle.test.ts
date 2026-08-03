import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BranchService } from "@/services/branch.service";
import { EntitlementService } from "@/services/entitlement.service";
import { createBranch, createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("workspace branch billing lifecycle", () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await disconnectDatabase(); });

  async function trialOrganization() {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const first = await createBranch({ organizationId: organization.id, name: "First" });
    const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await testPrisma.ownerTrialGrant.create({
      data: {
        ownerId: owner.id,
        organizationId: organization.id,
        source: "ONBOARDING",
        status: "ACTIVE",
        trialStartedAt: new Date(),
        trialEndsAt,
        consumedAt: new Date(),
      },
    });
    return { owner, organization, first, trialEndsAt };
  }

  it("adds active trial branches without extending the owner trial", async () => {
    const { owner, organization, trialEndsAt } = await trialOrganization();
    const branch = await BranchService.createBranchForOrg({
      organizationId: organization.id,
      userId: owner.id,
      name: "Second",
      contactPhone: "9876543210",
    });

    expect(branch.billingStatus).toBe("ACTIVE");
    await expect(testPrisma.ownerTrialGrant.findUniqueOrThrow({ where: { ownerId: owner.id } }))
      .resolves.toMatchObject({ trialEndsAt });
  });

  it("makes an unconverted V2 organization read-only", async () => {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const branch = await createBranch({ organizationId: organization.id });

    await expect(EntitlementService.assertBranchWritable(branch.id))
      .rejects.toThrow("paid subscription is required");
  });

  it("keeps pending writable but halted read-only", async () => {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const branch = await createBranch({ organizationId: organization.id });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_pending",
        status: "PENDING",
        providerPaymentMethod: "CARD",
      },
    });

    await expect(EntitlementService.assertBranchWritable(branch.id)).resolves.toBeDefined();
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { status: "HALTED" },
    });
    await expect(EntitlementService.assertBranchWritable(branch.id))
      .rejects.toThrow("Payment retries are exhausted");
  });

  it("schedules, undoes, and archives a trial branch without deleting data", async () => {
    const { owner, organization, first, trialEndsAt } = await trialOrganization();
    const second = await createBranch({ organizationId: organization.id, name: "Second" });

    const scheduled = await BranchService.scheduleBillingRemoval(owner.id, second.id, "remove-second-1");
    expect(scheduled.change).toMatchObject({ status: "QUEUED", effectiveAt: trialEndsAt });
    await BranchService.undoBillingRemoval(owner.id, second.id);
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: second.id } }))
      .resolves.toMatchObject({ billingStatus: "ACTIVE" });

    const again = await BranchService.scheduleBillingRemoval(owner.id, second.id, "remove-second-2");
    await BranchService.archiveDueBillingRemovals(new Date(trialEndsAt.getTime() + 1));
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: second.id } }))
      .resolves.toMatchObject({ billingStatus: "ARCHIVED" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: again.change.id } }))
      .resolves.toMatchObject({ status: "APPLIED" });
    await expect(testPrisma.branch.findUnique({ where: { id: first.id } })).resolves.not.toBeNull();
  });
});
