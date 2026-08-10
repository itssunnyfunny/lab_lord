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
      idempotencyKey: "trial-second-branch",
    });

    expect(branch.billingStatus).toBe("ACTIVE");
    await expect(testPrisma.ownerTrialGrant.findUniqueOrThrow({ where: { ownerId: owner.id } }))
      .resolves.toMatchObject({ trialEndsAt });
  });

  it("replays the same branch-create key to the original branch and change", async () => {
    const { owner, organization } = await trialOrganization();
    const input = {
      organizationId: organization.id,
      userId: owner.id,
      name: "Replay-safe branch",
      contactPhone: "9876543210",
      city: "Delhi",
      defaultFee: 1200,
      idempotencyKey: "create-replay-safe-branch",
    };

    const first = await BranchService.createBranchForOrg(input);
    const replay = await BranchService.createBranchForOrg(input);

    expect(replay.id).toBe(first.id);
    expect(replay.billingChangeId).toBe(first.billingChangeId);
    await expect(testPrisma.branch.count({ where: { organizationId: organization.id } })).resolves.toBe(2);
    await expect(testPrisma.organizationBillingChange.count({
      where: { idempotencyKey: input.idempotencyKey },
    })).resolves.toBe(1);
  });

  it("rejects a reused branch-create key when persisted details differ", async () => {
    const { owner, organization } = await trialOrganization();
    const input = {
      organizationId: organization.id,
      userId: owner.id,
      name: "Original branch",
      contactPhone: "9876543210",
      city: "Delhi",
      defaultFee: 1200,
      idempotencyKey: "create-payload-mismatch",
    };
    await BranchService.createBranchForOrg(input);

    await expect(BranchService.createBranchForOrg({ ...input, name: "Different branch" }))
      .rejects.toThrow("different branch details");
    await expect(testPrisma.branch.count({ where: { organizationId: organization.id } })).resolves.toBe(2);
  });

  it("rolls back branch creation when its atomic billing-change insert fails", async () => {
    const { owner, organization } = await trialOrganization();
    await testPrisma.organization.update({
      where: { id: organization.id },
      data: { billingMutationSequence: 0 },
    });
    await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        sequence: 1,
        idempotencyKey: "existing-sequence-owner",
        type: "LEGACY_TRANSITION",
        status: "APPLIED",
        operationStatus: "APPLIED",
      },
    });

    await expect(BranchService.createBranchForOrg({
      organizationId: organization.id,
      userId: owner.id,
      name: "Must roll back",
      contactPhone: "9876543210",
      idempotencyKey: "create-sequence-conflict",
    })).rejects.toThrow();

    await expect(testPrisma.branch.count({ where: { organizationId: organization.id } })).resolves.toBe(1);
    await expect(testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } }))
      .resolves.toMatchObject({ billingMutationSequence: 0 });
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
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_pending",
        status: "PENDING",
        providerPaymentMethod: "CARD",
      },
    });

    await expect(EntitlementService.assertBranchWritable(branch.id))
      .rejects.toThrow("paid access period has ended");
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { paidThrough: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    await expect(EntitlementService.assertBranchWritable(branch.id)).resolves.toBeDefined();
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { status: "HALTED" },
    });
    await expect(EntitlementService.assertBranchWritable(branch.id))
      .rejects.toThrow("Payment retries are exhausted");
  });

  it("blocks operational writes for a branch awaiting paid activation", async () => {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const branch = await createBranch({ organizationId: organization.id });
    await testPrisma.branch.update({ where: { id: branch.id }, data: { billingStatus: "PENDING_ACTIVATION" } });
    await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_active",
        status: "ACTIVE",
        providerPaymentMethod: "CARD",
        paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await expect(EntitlementService.assertBranchWritable(branch.id))
      .rejects.toThrow("awaiting provider-confirmed billing activation");
  });

  it("schedules, undoes, and archives a trial branch without deleting data", async () => {
    const { owner, organization, first, trialEndsAt } = await trialOrganization();
    const second = await createBranch({ organizationId: organization.id, name: "Second" });

    const scheduled = await BranchService.scheduleBillingRemoval(owner.id, second.id, "remove-second-1");
    expect(scheduled.change).toMatchObject({ status: "SCHEDULED", effectiveAt: trialEndsAt });
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

  it("replays branch removal without creating another change", async () => {
    const { owner, organization } = await trialOrganization();
    const second = await createBranch({ organizationId: organization.id, name: "Second" });

    const first = await BranchService.scheduleBillingRemoval(owner.id, second.id, "remove-replay-safe");
    const replay = await BranchService.scheduleBillingRemoval(owner.id, second.id, "remove-replay-safe");

    expect(replay.branch.id).toBe(first.branch.id);
    expect(replay.change.id).toBe(first.change.id);
    await expect(testPrisma.organizationBillingChange.count({
      where: { idempotencyKey: "remove-replay-safe" },
    })).resolves.toBe(1);
  });

  it("rolls back branch removal state when its atomic change insert fails", async () => {
    const { owner, organization } = await trialOrganization();
    const second = await createBranch({ organizationId: organization.id, name: "Second" });
    await testPrisma.organization.update({
      where: { id: organization.id },
      data: { billingMutationSequence: 0 },
    });
    await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        sequence: 1,
        idempotencyKey: "existing-removal-sequence",
        type: "LEGACY_TRANSITION",
        status: "APPLIED",
        operationStatus: "APPLIED",
      },
    });

    await expect(BranchService.scheduleBillingRemoval(owner.id, second.id, "remove-sequence-conflict"))
      .rejects.toThrow();
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: second.id } }))
      .resolves.toMatchObject({ billingStatus: "ACTIVE" });
  });

  it("rolls back archived-branch reactivation when its atomic change insert fails", async () => {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: organization.id, name: "Active" });
    const archived = await createBranch({ organizationId: organization.id, name: "Archived" });
    await testPrisma.branch.update({
      where: { id: archived.id },
      data: { billingStatus: "ARCHIVED", billingArchivedAt: new Date() },
    });
    await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_reactivate_rollback",
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_reactivate_rollback",
        status: "ACTIVE",
        providerPaymentMethod: "CARD",
        paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    await testPrisma.organization.update({
      where: { id: organization.id },
      data: { billingMutationSequence: 0 },
    });
    await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        sequence: 1,
        idempotencyKey: "existing-reactivation-sequence",
        type: "LEGACY_TRANSITION",
        status: "APPLIED",
        operationStatus: "APPLIED",
      },
    });

    await expect(BranchService.reactivateArchivedBranch(
      owner.id,
      archived.id,
      "reactivate-sequence-conflict"
    )).rejects.toThrow();
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: archived.id } }))
      .resolves.toMatchObject({ billingStatus: "ARCHIVED" });
  });
});
