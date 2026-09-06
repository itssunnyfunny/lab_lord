import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccessPolicy, type BranchAccessContext } from "@/services/accessPolicy.service";
import { StaffService } from "@/services/staff.service";
import { runBranchAI } from "@/ai/orchestrator/branchAI.orchestrator";
import { draftOverdueMessages } from "@/ai/messageDrafting/branchMessageDrafter";
import { createTestWorld, createUser, createStaff, createSaasSubscription } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("server-derived access policy", () => {
  beforeEach(resetDatabase);
  afterAll(disconnectDatabase);

  it("shares owner/manager/staff defaults and explicit denials with the compatibility facade", async () => {
    const { user, branch, org } = await createTestWorld();
    await createSaasSubscription({ organizationId: org.id });
    const manager = await createUser(), restricted = await createUser();
    const membership = await createStaff({ userId: manager.id, branchId: branch.id, role: "MANAGER" });
    await createStaff({ userId: restricted.id, branchId: branch.id });
    await expect(AccessPolicy.authorizeCapability(user.id, branch.id, "staffManage")).resolves.toMatchObject({ isOwner: true });
    await expect(AccessPolicy.authorizeCapability(manager.id, branch.id, "settingsManage")).resolves.toMatchObject({ role: "MANAGER" });
    await expect(AccessPolicy.authorizeCapability(restricted.id, branch.id, "studentsManage")).resolves.toMatchObject({ role: "STAFF" });
    await expect(AccessPolicy.authorizeCapability(manager.id, branch.id, "staffManage")).rejects.toThrow("Unauthorized");
    await testPrisma.staffPermissionOverride.create({ data: { staffId: membership.id, action: "VIEW_PAYMENTS", allowed: false } });
    await expect(AccessPolicy.authorizeCapability(manager.id, branch.id, "paymentsView")).rejects.toThrow("disabled");
    await expect(StaffService.authorize(manager.id, branch.id, "view_payments")).rejects.toThrow("disabled");
  });

  it("does not accept forged, copied, or permission-revoked AI contexts", async () => {
    const { branch, org } = await createTestWorld();
    await createSaasSubscription({ organizationId: org.id });
    const manager = await createUser();
    const membership = await createStaff({ userId: manager.id, branchId: branch.id, role: "MANAGER" });
    const context = await AccessPolicy.authorizeCapability(manager.id, branch.id, "aiGenerate");
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.permissions)).toBe(true);
    await expect(runBranchAI({ ...context } as BranchAccessContext)).rejects.toThrow("Invalid server access context");
    await expect(draftOverdueMessages({ actorId: manager.id, branchId: branch.id } as BranchAccessContext)).rejects.toThrow("Invalid server access context");
    await testPrisma.staffPermissionOverride.create({ data: { staffId: membership.id, action: "VIEW_PAYMENTS", allowed: false } });
    await expect(runBranchAI(context)).rejects.toThrow("disabled");
    await expect(draftOverdueMessages(context, { allowGeneration: false })).rejects.toThrow("disabled");
    expect(await testPrisma.branchGenerationLease.count()).toBe(0);
    expect(await testPrisma.messageDraft.count()).toBe(0);
  });

  it("rechecks membership and hides foreign and missing resources identically", async () => {
    const { branch, org } = await createTestWorld();
    const outsider = await createUser();
    for (const id of [branch.id, "missing_branch"]) {
      await expect(AccessPolicy.authorizeCapability(outsider.id, id, "studentsView")).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND", message: "Branch not found" });
    }
    for (const id of [org.id, "missing_org"]) {
      await expect(AccessPolicy.authorizeOrganization(outsider.id, id)).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
    }
    const staff = await createStaff({ userId: outsider.id, branchId: branch.id });
    const context = await AccessPolicy.authorizeCapability(outsider.id, branch.id, "studentsView");
    await testPrisma.staff.delete({ where: { id: staff.id } });
    await expect(AccessPolicy.recheckCapability(context, "studentsView")).rejects.toThrow("Branch not found");
  });

  it("keeps paid features, read-only writes, and billing recovery separate", async () => {
    const { user, branch, org } = await createTestWorld();
    await createSaasSubscription({ organizationId: org.id, plan: "BASIC" });
    await expect(AccessPolicy.authorizeCapability(user.id, branch.id, "aiUse")).rejects.toThrow();
    await expect(AccessPolicy.authorizeCapability(user.id, branch.id, "studentsManage")).resolves.toBeDefined();
    await testPrisma.branch.update({ where: { id: branch.id }, data: { billingStatus: "ARCHIVED" } });
    await expect(AccessPolicy.authorizeCapability(user.id, branch.id, "studentsView")).resolves.toBeDefined();
    await expect(AccessPolicy.authorizeCapability(user.id, branch.id, "studentsManage")).rejects.toThrow();
    await expect(AccessPolicy.readOwnerBranch(user.id, branch.id, { organization: true })).resolves.toMatchObject({ billingStatus: "ARCHIVED" });
    await expect(AccessPolicy.authorizeOrganization(user.id, org.id)).resolves.toMatchObject({ id: org.id });
  });
});
