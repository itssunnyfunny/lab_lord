import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { StaffInviteService } from "@/services/staffInvite.service";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffRole } from "@/types";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import {
  createStaff,
  createTestWorld as createBaseTestWorld,
  createUser,
} from "@/tests/factories";

vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: {
    assertBranchWritable: vi.fn().mockResolvedValue(undefined),
    assertBranchEntitlement: vi.fn().mockResolvedValue(undefined),
    assertOrganizationEntitlement: vi.fn().mockResolvedValue(undefined),
  },
}));

const createTestWorld = createBaseTestWorld;

describe("StaffInviteService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  describe("createInvite", () => {
    it("creates a one-use invite token for the branch owner", async () => {
      const { user, branch } = await createTestWorld();

      const invite = await StaffInviteService.createInvite(
        user.id,
        branch.id,
        StaffRole.STAFF,
        "New.Staff@Example.com"
      );

      expect(invite.branchId).toBe(branch.id);
      expect(invite.role).toBe("STAFF");
      expect(invite.token.length).toBeGreaterThan(20);
      expect(invite.token.startsWith("v2.")).toBe(true);
      expect(invite.token).not.toContain("New.Staff@Example.com");
      expect(invite.token).not.toContain("new.staff@example.com");
      expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(invite.acceptedAt).toBeNull();
    });

    it("rejects branch managers because staff invites are owner-only", async () => {
      const { branch } = await createTestWorld();
      const manager = await createUser();
      await createStaff({ userId: manager.id, branchId: branch.id, role: "MANAGER" });

      await expect(
        StaffInviteService.createInvite(manager.id, branch.id, StaffRole.STAFF, "staff@example.com")
      ).rejects.toThrow(/Unauthorized/i);
    });
  });

  describe("listActiveInvites", () => {
    it("lists only active pending invites for the owner", async () => {
      const { user, branch } = await createTestWorld();
      const active = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.STAFF, "active@example.com");
      const accepted = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.MANAGER, "accepted@example.com");
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
      const invite = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.STAFF, invitedUser.email);

      const revoked = await StaffInviteService.revokeInvite(user.id, branch.id, invite.id);

      expect(revoked.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      await expect(
        StaffInviteService.acceptInvite(invitedUser.id, invite.token)
      ).rejects.toThrow(/expired/i);
    });
  });

  describe("getInvitePreview", () => {
    it("returns workspace details without accepting or creating membership", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser({ email: "preview@example.com" });
      const invite = await StaffInviteService.createInvite(
        user.id,
        branch.id,
        StaffRole.STAFF,
        invitedUser.email
      );

      const preview = await StaffInviteService.getInvitePreview(invite.token);

      expect(preview.branch.id).toBe(branch.id);
      expect(preview.isExpired).toBe(false);
      expect(preview.isAccountRestricted).toBe(true);
      expect(await testPrisma.staff.findUnique({
        where: { userId_branchId: { userId: invitedUser.id, branchId: branch.id } },
      })).toBeNull();
      expect((await testPrisma.staffInvite.findUnique({ where: { id: invite.id } }))?.acceptedAt).toBeNull();
    });
  });

  describe("acceptInvite", () => {
    it("creates the staff membership and marks the invite accepted", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser();
      const invite = await StaffInviteService.createInvite(
        user.id,
        branch.id,
        StaffRole.MANAGER,
        invitedUser.email.toUpperCase()
      );

      const accepted = await StaffInviteService.acceptInvite(invitedUser.id, invite.token);

      expect(accepted.branchId).toBe(branch.id);
      const staff = await testPrisma.staff.findUnique({
        where: { userId_branchId: { userId: invitedUser.id, branchId: branch.id } },
      });
      expect(staff?.role).toBe("MANAGER");

      const savedInvite = await testPrisma.staffInvite.findUnique({ where: { id: invite.id } });
      expect(savedInvite?.acceptedAt).not.toBeNull();
    });

    it("does not create membership after the staff-management entitlement is lost", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser();
      const invite = await StaffInviteService.createInvite(
        user.id,
        branch.id,
        StaffRole.STAFF,
        invitedUser.email
      );
      vi.mocked(EntitlementService.assertBranchEntitlement)
        .mockRejectedValueOnce(new Error("staff management requires an upgraded subscription plan"));

      await expect(StaffInviteService.acceptInvite(invitedUser.id, invite.token))
        .rejects.toThrow(/upgraded subscription/i);

      expect(await testPrisma.staff.findUnique({
        where: { userId_branchId: { userId: invitedUser.id, branchId: branch.id } },
      })).toBeNull();
      expect((await testPrisma.staffInvite.findUnique({ where: { id: invite.id } }))?.acceptedAt)
        .toBeNull();
    });

    it("rejects expired invites", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser();
      const activeInvite = await StaffInviteService.createInvite(
        user.id,
        branch.id,
        StaffRole.STAFF,
        invitedUser.email
      );
      const invite = await testPrisma.staffInvite.update({
        where: { id: activeInvite.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await expect(
        StaffInviteService.acceptInvite(invitedUser.id, invite.token)
      ).rejects.toThrow(/expired/i);
    });

    it("does not overwrite an existing staff role when accepting another invite", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser();
      await createStaff({ userId: invitedUser.id, branchId: branch.id, role: "STAFF" });
      const invite = await StaffInviteService.createInvite(user.id, branch.id, StaffRole.MANAGER, invitedUser.email);

      await StaffInviteService.acceptInvite(invitedUser.id, invite.token);

      const staff = await testPrisma.staff.findUnique({
        where: { userId_branchId: { userId: invitedUser.id, branchId: branch.id } },
      });
      expect(staff?.role).toBe("STAFF");
    });

    it("rejects a signed-in account whose normalized email does not match", async () => {
      const { user, branch } = await createTestWorld();
      const invitedUser = await createUser({ email: "intended@example.com" });
      const otherUser = await createUser({ email: "other@example.com" });
      const invite = await StaffInviteService.createInvite(
        user.id,
        branch.id,
        StaffRole.STAFF,
        invitedUser.email
      );

      await expect(
        StaffInviteService.acceptInvite(otherUser.id, invite.token)
      ).rejects.toThrow(/different email/i);

      const savedInvite = await testPrisma.staffInvite.findUnique({ where: { id: invite.id } });
      expect(savedInvite?.acceptedAt).toBeNull();
      expect(await testPrisma.staff.findUnique({
        where: { userId_branchId: { userId: otherUser.id, branchId: branch.id } },
      })).toBeNull();
    });

    it("rejects legacy anonymous invite tokens", async () => {
      const { branch } = await createTestWorld();
      const invitedUser = await createUser();
      const invite = await testPrisma.staffInvite.create({
        data: {
          branchId: branch.id,
          role: "STAFF",
          token: "legacy-anonymous-token",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await expect(
        StaffInviteService.acceptInvite(invitedUser.id, invite.token)
      ).rejects.toThrow(/fresh invite/i);
    });
  });
});
