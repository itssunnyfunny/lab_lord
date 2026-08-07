import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { StaffService } from "@/services/staff.service";
import { StaffPermissionAction, StaffRole } from "@/types";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import {
  createTestWorld as createBaseTestWorld,
  createSaasSubscription,
  createUser,
  createStaff,
} from "@/tests/factories";

async function createTestWorld() {
  const world = await createBaseTestWorld();
  await createSaasSubscription({ organizationId: world.org.id, plan: "PRO" });
  return world;
}

/**
 * INTEGRATION TESTS: StaffService
 *
 * Uses REAL test database.
 * Covers:
 * 1. authorize() — owner always passes, MANAGER/STAFF role matrix, no-record throws
 * 2. addStaffByEmail() — happy path, target user not found, duplicate guard
 * 3. removeStaff() — happy path, non-owner blocked
 * 4. updateStaffRole() — role change persists
 * 5. listStaff() — owner can list, MANAGER can list, STAFF cannot list
 *
 * Note: Unit-level PERMISSION_MATRIX tests live in tests/unit/services/staff.test.ts.
 * This file tests the full DB-backed CRUD paths.
 */

describe("StaffService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  // ─── authorize ────────────────────────────────────────────────────────────

  describe("authorize", () => {
    it("Owner is always allowed for any action", async () => {
      const { user, branch } = await createTestWorld();
      await expect(StaffService.authorize(user.id, branch.id, "staff_management")).resolves.toBe(true);
      await expect(StaffService.authorize(user.id, branch.id, "manage_org")).resolves.toBe(true);
      await expect(StaffService.authorize(user.id, branch.id, "generate_payments")).resolves.toBe(true);
    });

    it("MANAGER is allowed for manage_branch", async () => {
      const { branch } = await createTestWorld();
      const managerUser = await createUser();
      await createStaff({ userId: managerUser.id, branchId: branch.id, role: "MANAGER" });

      await expect(
        StaffService.authorize(managerUser.id, branch.id, "manage_branch")
      ).resolves.toBe(true);
    });

    it("STAFF is denied for generate_payments", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });

      await expect(
        StaffService.authorize(staffUser.id, branch.id, "generate_payments")
      ).rejects.toThrow(/Unauthorized/i);
    });

    it("throws if user has no staff record on the branch", async () => {
      const { branch } = await createTestWorld();
      const stranger = await createUser();

      await expect(
        StaffService.authorize(stranger.id, branch.id, "students")
      ).rejects.toThrow(/Not a staff member/i);
    });

    it("allows a permission override to grant STAFF access beyond role defaults", async () => {
      const { user, branch } = await createTestWorld();
      const staffUser = await createUser();
      const staffRecord = await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });

      await StaffService.updateStaffPermissions(user.id, branch.id, staffRecord.id, { analytics: true });

      await expect(
        StaffService.authorize(staffUser.id, branch.id, "analytics")
      ).resolves.toBe(true);

      await expect(
        testPrisma.staffPermissionOverride.findUnique({
          where: {
            staffId_action: {
              staffId: staffRecord.id,
              action: StaffPermissionAction.ANALYTICS,
            },
          },
        })
      ).resolves.toMatchObject({ allowed: true });
    });

    it("allows a permission override to deny MANAGER access despite role defaults", async () => {
      const { user, branch } = await createTestWorld();
      const managerUser = await createUser();
      const staffRecord = await createStaff({ userId: managerUser.id, branchId: branch.id, role: "MANAGER" });

      await StaffService.updateStaffPermissions(user.id, branch.id, staffRecord.id, { manage_branch: false });

      await expect(
        StaffService.authorize(managerUser.id, branch.id, "manage_branch")
      ).rejects.toThrow(/disabled/i);
    });

    it("removes a permission override when it is reset to null", async () => {
      const { user, branch } = await createTestWorld();
      const managerUser = await createUser();
      const staffRecord = await createStaff({ userId: managerUser.id, branchId: branch.id, role: "MANAGER" });

      await StaffService.updateStaffPermissions(user.id, branch.id, staffRecord.id, { manage_branch: false });
      await StaffService.updateStaffPermissions(user.id, branch.id, staffRecord.id, { manage_branch: null });

      await expect(
        StaffService.authorize(managerUser.id, branch.id, "manage_branch")
      ).resolves.toBe(true);
      await expect(
        testPrisma.staffPermissionOverride.count({ where: { staffId: staffRecord.id } })
      ).resolves.toBe(0);
    });

    it("rejects permission updates from non-owners", async () => {
      const { branch } = await createTestWorld();
      const managerUser = await createUser();
      const staffRecord = await createStaff({ userId: managerUser.id, branchId: branch.id, role: "MANAGER" });

      await expect(
        StaffService.updateStaffPermissions(managerUser.id, branch.id, staffRecord.id, { analytics: true })
      ).rejects.toThrow(/Unauthorized/i);
    });

    it("returns effective branch access for owners and staff", async () => {
      const { user, branch } = await createTestWorld();
      const staffUser = await createUser();
      const staffRecord = await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });
      await StaffService.updateStaffPermissions(user.id, branch.id, staffRecord.id, {
        analytics: true,
        mark_payment_paid: false,
      });

      const ownerAccess = await StaffService.getBranchAccess(user.id, branch.id);
      const staffAccess = await StaffService.getBranchAccess(staffUser.id, branch.id);

      expect(ownerAccess.isOwner).toBe(true);
      expect(ownerAccess.organizationId).toBe(branch.organizationId);
      expect(ownerAccess.role).toBe("OWNER");
      expect(ownerAccess.permissions.staff_management).toBe(true);
      expect(staffAccess.isOwner).toBe(false);
      expect(staffAccess.organizationId).toBe(branch.organizationId);
      expect(staffAccess.role).toBe("STAFF");
      expect(staffAccess.permissions.students).toBe(true);
      expect(staffAccess.permissions.analytics).toBe(true);
      expect(staffAccess.permissions.mark_payment_paid).toBe(false);
      expect(staffAccess.permissions.staff_management).toBe(false);
    });
  });

  // ─── addStaff ─────────────────────────────────────────────────────────────

  describe("addStaffByEmail", () => {
    it("happy path — creates staff record with correct role", async () => {
      const { user, branch } = await createTestWorld();
      const targetUser = await createUser({ email: "staff.member@test.com" });

      await StaffService.addStaffByEmail(user.id, branch.id, "STAFF.MEMBER@Test.com", StaffRole.MANAGER);

      const record = await testPrisma.staff.findUnique({
        where: { userId_branchId: { userId: targetUser.id, branchId: branch.id } },
      });
      expect(record).not.toBeNull();
      expect(record!.role).toBe("MANAGER");
    });

    it("REJECTS if target user does not exist", async () => {
      const { user, branch } = await createTestWorld();

      await expect(
        StaffService.addStaffByEmail(user.id, branch.id, "missing@test.com", StaffRole.STAFF)
      ).rejects.toThrow(/sign in once/i);
    });

    it("REJECTS duplicate staff (same user added twice to same branch)", async () => {
      const { user, branch } = await createTestWorld();
      const targetUser = await createUser({ email: "duplicate@test.com" });

      await StaffService.addStaffByEmail(user.id, branch.id, targetUser.email, StaffRole.STAFF);

      await expect(
        StaffService.addStaffByEmail(user.id, branch.id, targetUser.email, StaffRole.MANAGER)
      ).rejects.toThrow(/already a staff/i);
    });

    it("REJECTS if actor is not the owner (non-owner cannot manage staff)", async () => {
      const { branch } = await createTestWorld();
      const nonOwner = await createUser();
      const targetUser = await createUser({ email: "blocked@test.com" });

      await expect(
        StaffService.addStaffByEmail(nonOwner.id, branch.id, targetUser.email, StaffRole.STAFF)
      ).rejects.toThrow(/Unauthorized/i);
    });
  });

  // ─── removeStaff ──────────────────────────────────────────────────────────

  describe("removeStaff", () => {
    it("happy path — staff record is deleted from DB", async () => {
      const { user, branch } = await createTestWorld();
      const targetUser = await createUser();
      const staffRecord = await createStaff({ userId: targetUser.id, branchId: branch.id, role: "STAFF" });

      await StaffService.removeStaff(user.id, branch.id, staffRecord.id);

      const deleted = await testPrisma.staff.findUnique({ where: { id: staffRecord.id } });
      expect(deleted).toBeNull();
    });

    it("does not delete a staff record belonging to another branch", async () => {
      const first = await createTestWorld();
      const second = await createTestWorld();
      const targetUser = await createUser();
      const foreignStaff = await createStaff({
        userId: targetUser.id,
        branchId: second.branch.id,
        role: "STAFF",
      });

      await expect(
        StaffService.removeStaff(first.user.id, first.branch.id, foreignStaff.id)
      ).rejects.toThrow("Staff member not found");

      await expect(
        StaffService.removeStaff(first.user.id, first.branch.id, "missing_staff")
      ).rejects.toThrow("Staff member not found");

      await expect(
        testPrisma.staff.findUnique({ where: { id: foreignStaff.id } })
      ).resolves.toMatchObject({ branchId: second.branch.id });
    });

    it("REJECTS if actor is not the owner", async () => {
      const { branch } = await createTestWorld();
      const nonOwner = await createUser();
      const targetUser = await createUser();
      const staffRecord = await createStaff({ userId: targetUser.id, branchId: branch.id, role: "STAFF" });

      await expect(
        StaffService.removeStaff(nonOwner.id, branch.id, staffRecord.id)
      ).rejects.toThrow(/Unauthorized/i);
    });
  });

  // ─── updateStaffRole ──────────────────────────────────────────────────────

  describe("updateStaffRole", () => {
    it("role change persists in the database", async () => {
      const { user, branch } = await createTestWorld();
      const targetUser = await createUser();
      const staffRecord = await createStaff({ userId: targetUser.id, branchId: branch.id, role: "STAFF" });

      await StaffService.updateStaffRole(user.id, branch.id, staffRecord.id, StaffRole.MANAGER);

      const updated = await testPrisma.staff.findUnique({ where: { id: staffRecord.id } });
      expect(updated!.role).toBe("MANAGER");
    });
  });

  // ─── listStaff ────────────────────────────────────────────────────────────

  describe("listStaff", () => {
    it("owner can list staff — returns records with user name and email", async () => {
      const { user, branch } = await createTestWorld();
      const targetUser = await createUser({ name: "Staff Member", email: "staff@test.com" });
      await createStaff({ userId: targetUser.id, branchId: branch.id, role: "STAFF" });

      const list = await StaffService.listStaff(user.id, branch.id);
      const found = list.find(s => s.userId === targetUser.id);
      expect(found).toBeDefined();
      expect(found!.user.name).toBe("Staff Member");
      expect(found!.user.email).toBe("staff@test.com");
    });

    it("MANAGER can list staff (manage_branch gate allows MANAGER)", async () => {
      const { branch } = await createTestWorld();
      const managerUser = await createUser();
      await createStaff({ userId: managerUser.id, branchId: branch.id, role: "MANAGER" });

      await expect(
        StaffService.listStaff(managerUser.id, branch.id)
      ).resolves.toBeDefined();
    });

    it("STAFF cannot list staff — denied by manage_branch gate", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });

      await expect(
        StaffService.listStaff(staffUser.id, branch.id)
      ).rejects.toThrow(/Unauthorized/i);
    });
  });
});
