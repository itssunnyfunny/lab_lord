import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingService } from "@/services/onboarding.service";
import { OwnerTrialService, TRIAL_DAYS } from "@/services/ownerTrial.service";
import { createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("owner-level trials", () => {
  beforeEach(async () => {
    process.env.WORKSPACE_BRANCH_BILLING_V2_ENABLED = "true";
    await resetDatabase();
  });
  afterEach(() => { delete process.env.WORKSPACE_BRANCH_BILLING_V2_ENABLED; });
  afterAll(async () => { await disconnectDatabase(); });

  const onboarding = (userId: string, suffix: string) => OnboardingService.createNetwork({
    userId,
    ownerPhone: "9876543210",
    orgData: { name: `Owner Org ${suffix}` },
    branchData: { name: `Main ${suffix}` },
  });

  it("starts exactly one 30-day trial when first-branch onboarding completes", async () => {
    const owner = await createUser();
    const before = Date.now();
    const first = await onboarding(owner.id, "A");
    const second = await onboarding(owner.id, "B");
    const after = Date.now();

    const grants = await testPrisma.ownerTrialGrant.findMany({ where: { ownerId: owner.id } });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      organizationId: first.org.id,
      source: "ONBOARDING",
      status: "ACTIVE",
    });
    expect(grants[0].trialStartedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(grants[0].trialStartedAt!.getTime()).toBeLessThanOrEqual(after);
    expect(grants[0].trialEndsAt!.getTime() - grants[0].trialStartedAt!.getTime())
      .toBe(TRIAL_DAYS * 24 * 60 * 60 * 1000);
    expect(second.org.billingModelVersion).toBe("WORKSPACE_V2");
  });

  it("lets the owner claim one migrated grant for a never-billed organization", async () => {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    await testPrisma.ownerTrialGrant.create({
      data: { ownerId: owner.id, source: "MIGRATION", status: "AVAILABLE" },
    });
    const now = new Date("2026-08-03T10:00:00.000Z");

    const claimed = await OwnerTrialService.claimMigratedTrial(owner.id, organization.id, now);

    expect(claimed).toMatchObject({
      organizationId: organization.id,
      status: "ACTIVE",
      trialStartedAt: now,
      consumedAt: now,
    });
    expect(claimed.trialEndsAt?.toISOString()).toBe("2026-09-02T10:00:00.000Z");
    await expect(OwnerTrialService.claimMigratedTrial(owner.id, organization.id, now))
      .rejects.toThrow("No migrated trial is available");
  });
});
