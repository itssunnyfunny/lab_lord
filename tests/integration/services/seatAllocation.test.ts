import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { SeatAllocationService } from "@/services/seatAllocation.service";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import { createTestWorld, createStudent, createShift, createSeat, createAllocation, createStaff, createUser } from "@/tests/factories";

/**
 * INTEGRATION TESTS: SeatAllocationService.assignSeatToShifts()
 *
 * Critical behaviors:
 * 1. Happy path — creates allocation records
 * 2. Seat conflict — same seat, overlapping shift → must fail
 * 3. Student conflict — same student, overlapping shift → must fail
 * 4. Requested shifts overlap each other → must fail
 * 5. Inactive student → must fail
 * 6. REGRESSION: double allocation same seat+shift must be prevented
 */

describe("SeatAllocationService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  describe("assignSeatToShifts — happy path", () => {
    it("creates allocation records for each requested shift", async () => {
      const { user, branch, seat } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      // Morning shift already created as part of createTestWorld
      const shift = await testPrisma.shift.findFirst({ where: { branchId: branch.id } });

      const result = await SeatAllocationService.assignSeatToShifts(
        user.id, seat.id, student.id, [shift!.id]
      );
      expect(result).toHaveLength(1);
      expect(result[0].studentId).toBe(student.id);
      expect(result[0].seatId).toBe(seat.id);
      expect(result[0].endDate).toBeNull();
    });

    it("allows STAFF role users to assign seats in their branch", async () => {
      const { branch, seat, shift } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });
      const student = await createStudent({ branchId: branch.id });

      const result = await SeatAllocationService.assignSeatToShifts(
        staffUser.id, seat.id, student.id, [shift.id]
      );

      expect(result).toHaveLength(1);
      expect(result[0].studentId).toBe(student.id);
    });

    it("creates TWO allocations for morning + evening (non-overlapping)", async () => {
      const { user, branch } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      const evening = await createShift({ branchId: branch.id, name: "Evening", startTime: "17:00", endTime: "22:00" });
      const seat = await createSeat({ branchId: branch.id });
      const student = await createStudent({ branchId: branch.id });

      const morningShift = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });
      const result = await SeatAllocationService.assignSeatToShifts(
        user.id, seat.id, student.id, [morningShift!.id, evening.id]
      );
      expect(result).toHaveLength(2);
    });
  });

  describe("assignSeatToShifts — conflict detection", () => {
    it("REJECTS if seat is already occupied in a time-overlapping shift", async () => {
      const { user, branch, seat, shift } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      const student1 = await createStudent({ branchId: branch.id, name: "Student 1" });
      const student2 = await createStudent({ branchId: branch.id, name: "Student 2" });

      // Assign student1 to the morning shift seat
      await createAllocation({ seatId: seat.id, studentId: student1.id, shiftId: shift.id });

      // Now try to assign student2 to same seat at overlapping time (09:00-14:00 overlaps 06:00-11:59)
      const overlappingShift = await createShift({
        branchId: branch.id,
        name: "Mid-Morning",
        startTime: "09:00",
        endTime: "14:00",
      });

      await expect(
        SeatAllocationService.assignSeatToShifts(user.id, seat.id, student2.id, [overlappingShift.id])
      ).rejects.toThrow(/occupied|conflict/i);
    });

    it("REJECTS if student is already in an overlapping shift", async () => {
      const { user, branch, shift } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      const student = await createStudent({ branchId: branch.id });
      const seat1 = await createSeat({ branchId: branch.id, label: "S1" });
      const seat2 = await createSeat({ branchId: branch.id, label: "S2" });

      // Assign student to morning
      await createAllocation({ seatId: seat1.id, studentId: student.id, shiftId: shift.id });

      // Try to assign same student to an overlapping time
      const illegalShift = await createShift({
        branchId: branch.id,
        name: "Overlap",
        startTime: "08:00",
        endTime: "13:00",
      });

      await expect(
        SeatAllocationService.assignSeatToShifts(user.id, seat2.id, student.id, [illegalShift.id])
      ).rejects.toThrow(/overlapping|already allocated/i);
    });

    it("REJECTS if requested shifts overlap each other (e.g. Morning + Full Time)", async () => {
      const { user, branch } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      const fullTime = await createShift({ branchId: branch.id, name: "Full Time", startTime: null, endTime: null });
      const morning = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });
      const seat = await createSeat({ branchId: branch.id });
      const student = await createStudent({ branchId: branch.id });

      await expect(
        SeatAllocationService.assignSeatToShifts(user.id, seat.id, student.id, [morning!.id, fullTime.id])
      ).rejects.toThrow(/overlap/i);
    });

    it("REJECTS INACTIVE student", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      await testPrisma.student.update({ where: { id: student.id }, data: { status: "INACTIVE" } });

      await expect(
        SeatAllocationService.assignSeatToShifts(user.id, seat.id, student.id, [shift.id])
      ).rejects.toThrow(/ACTIVE/);
    });
  });

  // ─── REGRESSION TEST ─────────────────────────────────────────────────────

  describe("REGRESSION: double allocation", () => {
    it("BUG #001 — Same seat + same shift cannot be allocated twice", async () => {
      /**
       * This test documents a real-category bug that was found during development.
       * If this test ever fails again, a regression was introduced.
       *
       * The bug: nothing prevented creating two SeatAllocation records
       * for the same seat+shift combination at the same time.
       * Fix: conflict check in assignSeatToShifts() throws early.
       */
      const { user, branch, seat, shift } = await createTestWorld();
      const student1 = await createStudent({ branchId: branch.id, name: "Alice" });
      const student2 = await createStudent({ branchId: branch.id, name: "Bob" });

      // First allocation succeeds
      await SeatAllocationService.assignSeatToShifts(user.id, seat.id, student1.id, [shift.id]);

      // Second allocation on SAME seat+shift must fail
      await expect(
        SeatAllocationService.assignSeatToShifts(user.id, seat.id, student2.id, [shift.id])
      ).rejects.toThrow();
    });

    it("serializes concurrent requests so only one student wins the same seat and shift", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student1 = await createStudent({ branchId: branch.id, name: "Concurrent Alice" });
      const student2 = await createStudent({ branchId: branch.id, name: "Concurrent Bob" });

      const results = await Promise.allSettled([
        SeatAllocationService.assignSeatToShifts(user.id, seat.id, student1.id, [shift.id]),
        SeatAllocationService.assignSeatToShifts(user.id, seat.id, student2.id, [shift.id]),
      ]);

      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(await testPrisma.seatAllocation.count({
        where: { seatId: seat.id, shiftId: shift.id, endDate: null },
      })).toBe(1);
    });
  });

  // ─── unassignSeat ─────────────────────────────────────────────────────────

  describe("unassignSeat", () => {
    it("happy path — sets endDate to a non-null Date value", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      const alloc = await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: shift.id });

      const updated = await SeatAllocationService.unassignSeat(user.id, alloc.id);

      expect(updated.endDate).not.toBeNull();
      expect(updated.endDate).toBeInstanceOf(Date);
    });

    it("double-release throws — second call rejects", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      const alloc = await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: shift.id });

      await SeatAllocationService.unassignSeat(user.id, alloc.id);

      await expect(
        SeatAllocationService.unassignSeat(user.id, alloc.id)
      ).rejects.toThrow(/already ended/i);
    });

    it("rejects users without branch access", async () => {
      const { branch, seat, shift } = await createTestWorld();
      const stranger = await createUser();
      const student = await createStudent({ branchId: branch.id });
      const alloc = await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: shift.id });

      await expect(
        SeatAllocationService.unassignSeat(stranger.id, alloc.id)
      ).rejects.toThrow(/Unauthorized|Not a staff member/i);
    });
  });

  // ─── listAllocations ─────────────────────────────────────────────────────

  describe("multi-shift mutation integrity", () => {
    it("releases every active component of the same bundle", async () => {
      const { user, branch, seat, shift: morning } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "10:00",
      });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "16:00",
        endTime: "20:00",
      });
      const fullDay = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          components: {
            create: [
              { shiftId: morning.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });
      const student = await createStudent({ branchId: branch.id });
      const allocations = await testPrisma.seatAllocation.createManyAndReturn({
        data: [
          { seatId: seat.id, studentId: student.id, shiftId: morning.id, multiShiftId: fullDay.id },
          { seatId: seat.id, studentId: student.id, shiftId: evening.id, multiShiftId: fullDay.id },
        ],
      });

      await SeatAllocationService.unassignSeat(user.id, allocations[0].id);

      expect(await testPrisma.seatAllocation.count({
        where: { studentId: student.id, seatId: seat.id, multiShiftId: fullDay.id, endDate: null },
      })).toBe(0);
    });

    it("rejects a target-seat overlap without ending the current allocation", async () => {
      const { user, branch, seat: currentSeat, shift: morning } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "11:00",
      });
      const targetSeat = await createSeat({ branchId: branch.id, label: "Target" });
      const overlap = await createShift({
        branchId: branch.id,
        name: "Overlap",
        startTime: "09:00",
        endTime: "14:00",
      });
      const student = await createStudent({ branchId: branch.id, name: "Moving" });
      const blocker = await createStudent({ branchId: branch.id, name: "Blocking" });
      const current = await createAllocation({
        seatId: currentSeat.id,
        studentId: student.id,
        shiftId: morning.id,
      });
      await createAllocation({ seatId: targetSeat.id, studentId: blocker.id, shiftId: overlap.id });

      await expect(SeatAllocationService.updateAllocation(
        user.id,
        [current.id],
        targetSeat.id,
        student.id,
        [morning.id]
      )).rejects.toThrow(/occupied|conflict/i);

      expect((await testPrisma.seatAllocation.findUnique({ where: { id: current.id } }))?.endDate).toBeNull();
      expect(await testPrisma.seatAllocation.count({
        where: { studentId: student.id, endDate: null },
      })).toBe(1);
    });

    it("rejects a student overlap without ending the current allocation", async () => {
      const { user, branch, seat: currentSeat, shift: currentShift } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "08:00",
      });
      const targetSeat = await createSeat({ branchId: branch.id, label: "Target" });
      const otherSeat = await createSeat({ branchId: branch.id, label: "Existing" });
      const requestedShift = await createShift({
        branchId: branch.id,
        name: "Requested",
        startTime: "09:00",
        endTime: "14:00",
      });
      const existingShift = await createShift({
        branchId: branch.id,
        name: "Existing",
        startTime: "12:00",
        endTime: "16:00",
      });
      const student = await createStudent({ branchId: branch.id });
      const current = await createAllocation({
        seatId: currentSeat.id,
        studentId: student.id,
        shiftId: currentShift.id,
      });
      await createAllocation({ seatId: otherSeat.id, studentId: student.id, shiftId: existingShift.id });

      await expect(SeatAllocationService.updateAllocation(
        user.id,
        [current.id],
        targetSeat.id,
        student.id,
        [requestedShift.id]
      )).rejects.toThrow(/student.*overlap|already allocated/i);

      expect((await testPrisma.seatAllocation.findUnique({ where: { id: current.id } }))?.endDate).toBeNull();
    });

    it("requires the exact component set and leaves old rows active on rejection", async () => {
      const { user, branch, seat, shift: morning } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "10:00",
      });
      const targetSeat = await createSeat({ branchId: branch.id, label: "Target" });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "16:00",
        endTime: "20:00",
      });
      const fullDay = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          components: {
            create: [
              { shiftId: morning.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });
      const student = await createStudent({ branchId: branch.id });
      const current = await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: morning.id });

      await expect(SeatAllocationService.updateAllocation(
        user.id,
        [current.id],
        targetSeat.id,
        student.id,
        [morning.id, morning.id],
        fullDay.id
      )).rejects.toThrow(/all component shifts/i);

      expect((await testPrisma.seatAllocation.findUnique({ where: { id: current.id } }))?.endDate).toBeNull();
    });

    it("expands one selected bundle row and recreates the complete bundle once", async () => {
      const { user, branch, seat, shift: morning } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "10:00",
      });
      const targetSeat = await createSeat({ branchId: branch.id, label: "Target" });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "16:00",
        endTime: "20:00",
      });
      const fullDay = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          components: {
            create: [
              { shiftId: morning.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });
      const student = await createStudent({ branchId: branch.id });
      const oldRows = await testPrisma.seatAllocation.createManyAndReturn({
        data: [
          { seatId: seat.id, studentId: student.id, shiftId: morning.id, multiShiftId: fullDay.id },
          { seatId: seat.id, studentId: student.id, shiftId: evening.id, multiShiftId: fullDay.id },
        ],
      });

      const created = await SeatAllocationService.updateAllocation(
        user.id,
        [oldRows[0].id],
        targetSeat.id,
        student.id,
        [morning.id, evening.id, evening.id],
        fullDay.id
      );

      expect(created).toHaveLength(2);
      expect(new Set(created.map((allocation) => allocation.shiftId))).toEqual(new Set([morning.id, evening.id]));
      expect(await testPrisma.seatAllocation.count({
        where: { id: { in: oldRows.map((allocation) => allocation.id) }, endDate: null },
      })).toBe(0);
      expect(await testPrisma.seatAllocation.count({
        where: { seatId: targetSeat.id, studentId: student.id, multiShiftId: fullDay.id, endDate: null },
      })).toBe(2);
    });

    it("treats a full-day target as overlapping an overnight allocation", async () => {
      const { user, branch, seat, shift: currentShift } = await createTestWorld({
        shiftStart: "08:00",
        shiftEnd: "12:00",
      });
      const targetSeat = await createSeat({ branchId: branch.id, label: "Target" });
      const overnight = await createShift({
        branchId: branch.id,
        name: "Overnight",
        startTime: "22:00",
        endTime: "06:00",
      });
      const fullDay = await testPrisma.shift.create({
        data: {
          branchId: branch.id,
          name: "All Day",
          startTime: null,
          endTime: null,
        },
      });
      const student = await createStudent({ branchId: branch.id, name: "Moving" });
      const blocker = await createStudent({ branchId: branch.id, name: "Blocking" });
      const current = await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: currentShift.id });
      await createAllocation({ seatId: targetSeat.id, studentId: blocker.id, shiftId: overnight.id });

      await expect(SeatAllocationService.updateAllocation(
        user.id,
        [current.id],
        targetSeat.id,
        student.id,
        [fullDay.id]
      )).rejects.toThrow(/occupied|conflict/i);
      expect((await testPrisma.seatAllocation.findUnique({ where: { id: current.id } }))?.endDate).toBeNull();
    });
  });

  describe("listAllocations", () => {
    it("{ activeOnly: true } returns only allocations with endDate === null", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student1 = await createStudent({ branchId: branch.id, name: "Active" });
      const student2 = await createStudent({ branchId: branch.id, name: "Ended" });

      // Active allocation
      await createAllocation({ seatId: seat.id, studentId: student1.id, shiftId: shift.id });

      // Ended allocation (create a second seat to avoid label collision)
      const seat2 = await createSeat({ branchId: branch.id, label: "S2" });
      await createAllocation({
        seatId: seat2.id,
        studentId: student2.id,
        shiftId: shift.id,
        endDate: new Date("2026-01-01"),
      });

      const results = await SeatAllocationService.listAllocations(user.id, branch.id, { activeOnly: true });
      expect(results.items).toHaveLength(1);
      expect(results.items[0].student.name).toBe("Active");
    });

    it("no filters returns all allocations — active and historical", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student1 = await createStudent({ branchId: branch.id, name: "Active" });
      const student2 = await createStudent({ branchId: branch.id, name: "Ended" });

      await createAllocation({ seatId: seat.id, studentId: student1.id, shiftId: shift.id });

      const seat2 = await createSeat({ branchId: branch.id, label: "S2" });
      await createAllocation({
        seatId: seat2.id,
        studentId: student2.id,
        shiftId: shift.id,
        endDate: new Date("2026-01-01"),
      });

      const results = await SeatAllocationService.listAllocations(user.id, branch.id);
      expect(results.items).toHaveLength(2);
    });

    it("paginates with stable startDate and id ordering", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, name: "Paged" });
      const startDate = new Date("2026-02-01T00:00:00.000Z");
      await testPrisma.seatAllocation.createMany({
        data: [
          { id: "allocation_a", seatId: seat.id, studentId: student.id, shiftId: shift.id, startDate },
          { id: "allocation_b", seatId: seat.id, studentId: student.id, shiftId: shift.id, startDate },
        ],
      });

      const first = await SeatAllocationService.listAllocations(user.id, branch.id, {}, { limit: 1 });
      expect(first.items.map(allocation => allocation.id)).toEqual(["allocation_b"]);
      expect(first.nextCursor).not.toBeNull();

      const { decodeDateIdCursor } = await import("@/lib/cursorPagination");
      const second = await SeatAllocationService.listAllocations(user.id, branch.id, {}, {
        limit: 1,
        cursor: decodeDateIdCursor(first.nextCursor),
      });
      expect(second.items.map(allocation => allocation.id)).toEqual(["allocation_a"]);
    });

    it("filters active and ended allocations by exact multi-shift identity", async () => {
      const { user, branch, shift: morning, seat } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "10:00",
      });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "16:00",
        endTime: "20:00",
      });
      const fullDay = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          components: {
            create: [
              { shiftId: morning.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });
      const bundleStudent = await createStudent({ branchId: branch.id, name: "Bundle Student" });
      const morningOnlyStudent = await createStudent({ branchId: branch.id, name: "Morning Only" });
      const morningOnlySeat = await createSeat({ branchId: branch.id, label: "M1" });
      const endedSeat = await createSeat({ branchId: branch.id, label: "E1" });
      const endedStudent = await createStudent({ branchId: branch.id, name: "Ended Bundle" });

      await testPrisma.seatAllocation.createMany({
        data: [
          { seatId: seat.id, studentId: bundleStudent.id, shiftId: morning.id, multiShiftId: fullDay.id },
          { seatId: seat.id, studentId: bundleStudent.id, shiftId: evening.id, multiShiftId: fullDay.id },
          { seatId: morningOnlySeat.id, studentId: morningOnlyStudent.id, shiftId: morning.id },
          { seatId: endedSeat.id, studentId: endedStudent.id, shiftId: morning.id, multiShiftId: fullDay.id, endDate: new Date("2026-02-01") },
        ],
      });

      const active = await SeatAllocationService.listAllocations(
        user.id,
        branch.id,
        { status: "ACTIVE", multiShiftId: fullDay.id },
        { all: true }
      );
      const ended = await SeatAllocationService.listAllocations(
        user.id,
        branch.id,
        { status: "ENDED", multiShiftId: fullDay.id },
        { all: true }
      );

      expect(active.items).toHaveLength(2);
      expect(new Set(active.items.map(allocation => allocation.student.name))).toEqual(new Set(["Bundle Student"]));
      expect(ended.items.map(allocation => allocation.student.name)).toEqual(["Ended Bundle"]);
    });
  });
});
