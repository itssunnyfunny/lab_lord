import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { MultiShiftService } from "@/services/multiShift.service";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import {
  createTestWorld,
  createUser,
  createShift,
  createSeat,
  createStudent,
} from "@/tests/factories";

/**
 * INTEGRATION TESTS: MultiShiftService
 *
 * Uses REAL test database.
 * Key behaviors under test:
 * 1. createMultiShift — happy path, < 2 shifts, wrong branch, INACTIVE shift, duplicate combination
 * 2. updateMultiShift — name/price only, component replacement, duplicate combination on update
 * 3. deleteMultiShift — soft-nulls multiShiftId on existing allocations, non-owner blocked
 * 4. listMultiShifts — DTO shape, empty array
 *
 * Setup pattern: Every test needs at least 2 ACTIVE primary shifts (non-overlapping).
 * createTestWorld creates Morning (06:00–11:59). We add Evening (17:00–22:00) in each test.
 */

describe("MultiShiftService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async function setupTwoShifts() {
    const world = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
    const { user, branch } = world;
    const morning = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });
    const evening = await createShift({
      branchId: branch.id,
      name: "Evening",
      startTime: "17:00",
      endTime: "22:00",
    });
    return { user, branch, morning: morning!, evening };
  }

  // ─── createMultiShift ─────────────────────────────────────────────────────

  describe("createMultiShift", () => {
    it("happy path — creates multi-shift with correct DTO shape", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();

      const ms = await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "Full Day",
        price: 1500,
        shiftIds: [morning.id, evening.id],
      });

      expect(ms.name).toBe("Full Day");
      expect(ms.price).toBe(1500);
      expect(ms.id).toBeDefined();
      expect(ms.components).toHaveLength(2);
      expect(ms.components[0]).toMatchObject({
        shiftId: expect.any(String),
        shiftName: expect.any(String),
        order: expect.any(Number),
      });
    });

    it("REJECTS when fewer than 2 shifts are provided", async () => {
      const { user, branch, morning } = await setupTwoShifts();

      await expect(
        MultiShiftService.createMultiShift(user.id, branch.id, {
          name: "Only One",
          shiftIds: [morning.id],
        })
      ).rejects.toThrow(/at least 2/i);
    });

    it("REJECTS shifts from another branch", async () => {
      const { user, branch, morning } = await setupTwoShifts();

      // Create a second branch with its own shift
      const { branch: branch2 } = await createTestWorld();
      const foreignShift = await testPrisma.shift.findFirst({ where: { branchId: branch2.id } });

      await expect(
        MultiShiftService.createMultiShift(user.id, branch.id, {
          name: "Cross Branch",
          shiftIds: [morning.id, foreignShift!.id],
        })
      ).rejects.toThrow(/does not belong/i);
    });

    it("REJECTS INACTIVE shifts", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();

      // Mark morning as INACTIVE
      await testPrisma.shift.update({
        where: { id: morning.id },
        data: { status: "INACTIVE" },
      });

      await expect(
        MultiShiftService.createMultiShift(user.id, branch.id, {
          name: "Inactive Combo",
          shiftIds: [morning.id, evening.id],
        })
      ).rejects.toThrow(/not active/i);
    });

    it("REJECTS duplicate combination (same shifts, different order)", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();

      // Create first multi-shift [morning, evening]
      await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "Full Day A",
        shiftIds: [morning.id, evening.id],
      });

      // Try to create [evening, morning] — same set, different order
      await expect(
        MultiShiftService.createMultiShift(user.id, branch.id, {
          name: "Full Day B",
          shiftIds: [evening.id, morning.id],
        })
      ).rejects.toThrow(/already exists/i);
    });

    it("REJECTS invalid name, price, and component IDs", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();

      await expect(
        MultiShiftService.createMultiShift(user.id, branch.id, {
          name: "",
          shiftIds: [morning.id, evening.id],
        })
      ).rejects.toThrow(/required/i);

      await expect(
        MultiShiftService.createMultiShift(user.id, branch.id, {
          name: "Bad Price",
          price: -1,
          shiftIds: [morning.id, evening.id],
        })
      ).rejects.toThrow(/whole number|at least/i);

      await expect(
        MultiShiftService.createMultiShift(user.id, branch.id, {
          name: "Duplicate IDs",
          shiftIds: [morning.id, morning.id],
        })
      ).rejects.toThrow(/valid shift IDs/i);
    });
  });

  // ─── updateMultiShift ─────────────────────────────────────────────────────

  describe("updateMultiShift", () => {
    it("updates name and price only — components unchanged", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();
      const ms = await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "Original",
        price: 1000,
        shiftIds: [morning.id, evening.id],
      });

      const updated = await MultiShiftService.updateMultiShift(user.id, ms.id, {
        name: "Renamed",
        price: 2000,
      });

      expect(updated.name).toBe("Renamed");
      expect(updated.price).toBe(2000);
      // Components must be unchanged
      expect(updated.components).toHaveLength(2);
    });

    it("syncs linked student fees when bundle price changes", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();
      const ms = await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "Full Day",
        price: 1500,
        shiftIds: [morning.id, evening.id],
      });
      const linkedStudent = await createStudent({
        branchId: branch.id,
        monthlyFee: 1500,
        feeLinkedMultiShiftId: ms.id,
      });
      const manualStudent = await createStudent({
        branchId: branch.id,
        monthlyFee: 1500,
      });

      await MultiShiftService.updateMultiShift(user.id, ms.id, { price: 2200 });

      const refreshedLinked = await testPrisma.student.findUnique({ where: { id: linkedStudent.id } });
      const refreshedManual = await testPrisma.student.findUnique({ where: { id: manualStudent.id } });

      expect(refreshedLinked?.monthlyFee).toBe(2200);
      expect(refreshedManual?.monthlyFee).toBe(1500);
    });

    it("updates components — replaces old, creates new", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();
      // Create a third shift (Afternoon)
      const afternoon = await createShift({
        branchId: branch.id,
        name: "Afternoon",
        startTime: "12:00",
        endTime: "16:59",
      });

      const ms = await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "Morning+Evening",
        shiftIds: [morning.id, evening.id],
      });

      // Update to [morning + afternoon]
      const updated = await MultiShiftService.updateMultiShift(user.id, ms.id, {
        shiftIds: [morning.id, afternoon.id],
      });

      expect(updated.components).toHaveLength(2);
      const shiftIds = updated.components.map(c => c.shiftId);
      expect(shiftIds).toContain(morning.id);
      expect(shiftIds).toContain(afternoon.id);
      expect(shiftIds).not.toContain(evening.id);
    });

    it("REJECTS duplicate combination on update", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();
      const afternoon = await createShift({
        branchId: branch.id,
        name: "Afternoon",
        startTime: "12:00",
        endTime: "16:59",
      });

      // ms1 = [morning + evening], ms2 = [morning + afternoon]
      await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "ms1",
        shiftIds: [morning.id, evening.id],
      });
      const ms2 = await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "ms2",
        shiftIds: [morning.id, afternoon.id],
      });

      // Try to update ms2 to [morning + evening] — conflicts with ms1
      await expect(
        MultiShiftService.updateMultiShift(user.id, ms2.id, {
          shiftIds: [morning.id, evening.id],
        })
      ).rejects.toThrow(/already exists/i);
    });
  });

  // ─── deleteMultiShift ─────────────────────────────────────────────────────

  describe("deleteMultiShift", () => {
    it("soft-nulls multiShiftId on existing allocations — history preserved", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();
      const ms = await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "Full Day",
        shiftIds: [morning.id, evening.id],
      });

      // Create an allocation that references this multi-shift
      const seat = await createSeat({ branchId: branch.id, label: "D1" });
      const student = await createStudent({ branchId: branch.id });
      const alloc = await testPrisma.seatAllocation.create({
        data: {
          seatId: seat.id,
          studentId: student.id,
          shiftId: morning.id,
          multiShiftId: ms.id,
          branchId: branch.id,
        },
      });

      await MultiShiftService.deleteMultiShift(user.id, ms.id);

      // Allocation must still exist but multiShiftId must be null
      const refreshed = await testPrisma.seatAllocation.findUnique({ where: { id: alloc.id } });
      expect(refreshed).not.toBeNull();
      expect(refreshed!.multiShiftId).toBeNull();
    });

    it("REJECTS delete by non-owner", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();
      const ms = await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "To Delete",
        shiftIds: [morning.id, evening.id],
      });

      const wrongUser = await createUser();
      await expect(
        MultiShiftService.deleteMultiShift(wrongUser.id, ms.id)
      ).rejects.toThrow(/Unauthorized/i);
    });
  });

  // ─── listMultiShifts ──────────────────────────────────────────────────────

  describe("listMultiShifts", () => {
    it("returns correct DTO shape for existing multi-shifts", async () => {
      const { user, branch, morning, evening } = await setupTwoShifts();
      await MultiShiftService.createMultiShift(user.id, branch.id, {
        name: "Full Day",
        price: 1200,
        shiftIds: [morning.id, evening.id],
      });

      const list = await MultiShiftService.listMultiShifts(user.id, branch.id);
      expect(list).toHaveLength(1);

      const item = list[0];
      expect(item).toMatchObject({
        id: expect.any(String),
        name: "Full Day",
        price: 1200,
        createdAt: expect.any(Date),
      });
      expect(item.components).toHaveLength(2);
      expect(item.components[0]).toMatchObject({
        shiftId: expect.any(String),
        shiftName: expect.any(String),
        startTime: expect.any(String),
        order: expect.any(Number),
      });
    });

    it("returns empty array when no multi-shifts exist", async () => {
      const { user, branch } = await setupTwoShifts();
      const list = await MultiShiftService.listMultiShifts(user.id, branch.id);
      expect(list).toHaveLength(0);
    });
  });
});
