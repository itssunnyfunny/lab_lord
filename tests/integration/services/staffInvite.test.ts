import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { StaffInviteService } from "@/services/staffInvite.service";
import { StaffRole } from "@/types";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
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

describe("StaffInviteService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  describe("createInvite", () => {
    it("creates a one-use invite token for the branch owner", async () => {
      const { user, branch } = await createTestWorld();

      const invite = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.STAFF);

      expect(invite.branchId).toBe(branch.id);
      expect(invite.role).toBe("STAFF");
      expect(invite.token.length).toBeGreaterThan(20);
      expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(invite.acceptedAt).toBeNull();
    });

    it("rejects branch managers because staff invites are owner-only", async () => {
      const { branch } = await createTestWorld();
      const manager = await createUser();
      await createStaff({ userId: manager.id, branchId: branch.id, role: "MANAGER" });

      await expect(
        StaffInviteService.createInvite(manager.id, branch.id, StaffRole.STAFF)
      ).rejects.toThrow(/Unauthorized/i);
    });
  });

  describe("listActiveInvites", () => {
    it("lists only active pending invites for the owner", async () => {
      const { user, branch } = await createTestWorld();
      const active = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.STAFF);
      const accepted = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.MANAGER);
      const expired = await testPrisma.staffInvite.create({
        data: {
          branchId: branch.id,
          role: "STAFF",
          token: "expired-list-token",
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      await testPrisma.staffInvite.update({
        where: { id: accepted.id },
        data: { acceptedAt: new Date() },
      });

      const invites = await StaffInviteService.listActiveInvites(user.id, branch.id);

      expect(invites.map(invite => invite.id)).toEqual([active.id]);
      expect(invites.find(invite => invite.id === accepted.id)).toBeUndefined();
      expect(invites.find(invite => invite.id === expired.id)).toBeUndefined();
    });
  });

  describe("revokeInvite", () => {
    it("expires a pending invite so it can no longer be accepted", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser();
      const invite = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.STAFF);

      const revoked = await StaffInviteService.revokeInvite(user.id, branch.id, invite.id);

      expect(revoked.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      await expect(
        StaffInviteService.acceptInvite(invitedUser.id, invite.token)
      ).rejects.toThrow(/expired/i);
    });
  });

  describe("acceptInvite", () => {
    it("creates the staff membership and marks the invite accepted", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser();
      const invite = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.MANAGER);

      const accepted = await StaffInviteService.acceptInvite(invitedUser.id, invite.token);

      expect(accepted.branchId).toBe(branch.id);
      const staff = await testPrisma.staff.findUnique({
        where: { userId_branchId: { userId: invitedUser.id, branchId: branch.id } },
      });
      expect(staff?.role).toBe("MANAGER");

      const savedInvite = await testPrisma.staffInvite.findUnique({ where: { id: invite.id } });
      expect(savedInvite?.acceptedAt).not.toBeNull();
    });

    it("rejects expired invites", async () => {
      const { branch } = await createTestWorld();
      const invitedUser = await createUser();
      const invite = await testPrisma.staffInvite.create({
        data: {
          branchId: branch.id,
          role: "STAFF",
          token: "expired-token",
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      await expect(
        StaffInviteService.acceptInvite(invitedUser.id, invite.token)
      ).rejects.toThrow(/expired/i);
    });

    it("does not overwrite an existing staff role when accepting another invite", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser();
      await createStaff({ userId: invitedUser.id, branchId: branch.id, role: "STAFF" });
      const invite = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.MANAGER);

      await StaffInviteService.acceptInvite(invitedUser.id, invite.token);

      const staff = await testPrisma.staff.findUnique({
        where: { userId_branchId: { userId: invitedUser.id, branchId: branch.id } },
      });
      expect(staff?.role).toBe("STAFF");
    });
  });
});
