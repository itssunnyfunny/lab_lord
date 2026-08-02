import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import { createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

async function createSubscription(
  organizationId: string,
  plan: "BASIC" | "PRO",
  status: "ACTIVE" | "EXPIRED" = "ACTIVE"
) {
  return testPrisma.organizationSubscription.create({
    data: {
      organizationId,
      plan,
      amount: plan === "BASIC" ? 399 : 599,
      amountSubunits: plan === "BASIC" ? 39900 : 59900,
      currency: "INR",
      period: "monthly",
      interval: 1,
      totalCount: 120,
      razorpayPlanId: `plan_${plan.toLowerCase()}_${organizationId}`,
      razorpaySubscriptionId: `sub_${plan.toLowerCase()}_${organizationId}`,
      status,
      currentEnd: status === "ACTIVE" ? new Date(Date.now() + 86_400_000) : new Date(Date.now() - 86_400_000),
    },
  });
}

describe("subscription entitlements", () => {
  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("grandfathers organizations that have never subscribed", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    const profile = await EntitlementService.getOrganizationProfile(org.id);

    expect(profile.grandfathered).toBe(true);
    expect(profile.limits.maxBranches).toBeNull();
    expect(profile.entitlements).toContain("ADVANCED_ANALYTICS");
  });

  it("limits Basic organizations to one branch and core features", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await createSubscription(org.id, "BASIC");
    const branch = await testPrisma.branch.create({
      data: { organizationId: org.id, name: "Main", contactPhone: "+919876543210" },
    });

    await expect(EntitlementService.assertCanCreateBranch(org.id)).rejects.toThrow("up to 1 branch");
    await expect(StaffService.authorize(user.id, branch.id, "analytics")).rejects.toThrow("upgraded subscription");
    await expect(StaffService.listStaff(user.id, branch.id)).rejects.toThrow("upgraded subscription");
  });

  it("enables Pro multi-branch, staff, and analytics capabilities", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await createSubscription(org.id, "PRO");
    const branch = await testPrisma.branch.create({
      data: { organizationId: org.id, name: "Main", contactPhone: "+919876543210" },
    });

    const profile = await EntitlementService.assertCanCreateBranch(org.id);
    expect(profile).toMatchObject({
      grandfathered: false,
      limits: { maxBranches: 3 },
    });
    await expect(StaffService.authorize(user.id, branch.id, "analytics")).resolves.toBe(true);
    await expect(StaffService.listStaff(user.id, branch.id)).resolves.toEqual([]);
  });

  it("removes premium entitlements after a subscription expires", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await createSubscription(org.id, "PRO", "EXPIRED");

    const profile = await EntitlementService.getOrganizationProfile(org.id);

    expect(profile.entitlements).not.toContain("ADVANCED_ANALYTICS");
    expect(profile.limits.maxBranches).toBe(1);
  });
});
