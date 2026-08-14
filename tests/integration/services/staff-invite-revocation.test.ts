import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { StaffInviteService } from "@/services/staffInvite.service";
import { StaffService } from "@/services/staff.service";
import { StaffRole } from "@/types";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";
import {
  createSaasSubscription,
  createStaff,
  createTestWorld as createBaseTestWorld,
  createUser,
} from "@/tests/factories";

async function createTestWorld() {
  const world = await createBaseTestWorld();
  await createSaasSubscription({ organizationId: world.org.id, plan: "PRO" });
  return world;
}

describe("staff removal invite revocation", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  it("revokes every live duplicate invite for the removed member's email", async () => {
    const { user: owner, branch } = await createTestWorld();
    const removedUser = await createUser({ email: "removed.staff@example.com" });
    const membership = await createStaff({
      userId: removedUser.id,
      branchId: branch.id,
      role: "STAFF",
    });
    const firstInvite = await StaffInviteService.createInvite(
      owner.id,
      branch.id,
      StaffRole.STAFF,
      removedUser.email
    );
    const duplicateInvite = await StaffInviteService.createInvite(
      owner.id,
      branch.id,
      StaffRole.MANAGER,
      removedUser.email.toUpperCase()
    );

    await StaffService.removeStaff(owner.id, branch.id, membership.id);

    const savedInvites = await testPrisma.staffInvite.findMany({
      where: { id: { in: [firstInvite.id, duplicateInvite.id] } },
    });
    expect(savedInvites).toHaveLength(2);
    expect(savedInvites.every(invite => invite.expiresAt.getTime() <= Date.now())).toBe(true);

    await expect(
      StaffInviteService.acceptInvite(removedUser.id, firstInvite.token)
    ).rejects.toThrow(/expired/i);
    await expect(
      StaffInviteService.acceptInvite(removedUser.id, duplicateInvite.token)
    ).rejects.toThrow(/expired/i);
    await expect(testPrisma.staff.findUnique({
      where: {
        userId_branchId: {
          userId: removedUser.id,
          branchId: branch.id,
        },
      },
    })).resolves.toBeNull();
  });

  it("leaves another recipient's invite valid and acceptable", async () => {
    const { user: owner, branch } = await createTestWorld();
    const removedUser = await createUser({ email: "removed.staff@example.com" });
    const otherRecipient = await createUser({ email: "other.staff@example.com" });
    const membership = await createStaff({
      userId: removedUser.id,
      branchId: branch.id,
      role: "STAFF",
    });
    await StaffInviteService.createInvite(
      owner.id,
      branch.id,
      StaffRole.STAFF,
      removedUser.email
    );
    const otherInvite = await StaffInviteService.createInvite(
      owner.id,
      branch.id,
      StaffRole.MANAGER,
      otherRecipient.email
    );

    await StaffService.removeStaff(owner.id, branch.id, membership.id);

    const untouchedInvite = await testPrisma.staffInvite.findUniqueOrThrow({
      where: { id: otherInvite.id },
    });
    expect(untouchedInvite.acceptedAt).toBeNull();
    expect(untouchedInvite.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await expect(
      StaffInviteService.acceptInvite(otherRecipient.id, otherInvite.token)
    ).resolves.toMatchObject({ branchId: branch.id });
    await expect(testPrisma.staff.findUnique({
      where: {
        userId_branchId: {
          userId: otherRecipient.id,
          branchId: branch.id,
        },
      },
    })).resolves.toMatchObject({ role: "MANAGER" });
  });
});
