import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { SeatService } from "@/services/seat.service";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import {
  createTestWorld,
  createUser,
  createShift,
  createSeat,
  createStudent,
  createAllocation,
  createStaff,
} from "@/tests/factories";

/**
 * INTEGRATION TESTS: SeatService
 *
 * Uses REAL test database.
 * Covers:
 * 1. createSeat — happy path, duplicate label, non-owner
 * 2. listSeats — with active allocations, ended allocations excluded
 * 3. generateOccupancySnapshot — math correctness, 0% baseline, used ≤ capacity invariant
 * 4. getSeatMap — primary shift (exact hit, time-overlap), multi-shift path
 * 5. getShiftsCapacity — used/available/isFull, studentAlreadyAllocated detection
 */

describe("SeatService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  // ─── createSeat ────────────────────────────────────────────────────────────

  describe("createSeat", () => {
    it("happy path — creates seat with correct branchId and label", async () => {
      const { user, branch } = await createTestWorld();
      const seat = await SeatService.createSeat(user.id, branch.id, "A1");
      expect(seat.branchId).toBe(branch.id);
      expect(seat.label).toBe("A1");
    });

    it("REJECTS duplicate label in same branch", async () => {
      const { user, branch } = await createTestWorld();
      await SeatService.createSeat(user.id, branch.id, "A1");
      await expect(
        SeatService.createSeat(user.id, branch.id, "A1")
      ).rejects.toThrow(/already exists/i);
    });

    it("REJECTS non-owner call", async () => {
      const { branch } = await createTestWorld();
      const wrongUser = await createUser();
      await expect(
        SeatService.createSeat(wrongUser.id, branch.id, "X1")
      ).rejects.toThrow("Branch not found");
    });

    it("REJECTS STAFF role users from creating physical seats", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });

      await expect(
        SeatService.createSeat(staffUser.id, branch.id, "S9")
      ).rejects.toThrow(/Unauthorized/i);
    });

    it("REJECTS invalid seat labels", async () => {
      const { user, branch } = await createTestWorld();

      await expect(
        SeatService.createSeat(user.id, branch.id, "")
      ).rejects.toThrow(/required/i);

      await expect(
        SeatService.createSeat(user.id, branch.id, "#A1")
      ).rejects.toThrow(/letters|numbers/i);
    });
  });

  describe("generateSeats", () => {
    it("creates a generated batch of seats", async () => {
      const { user, branch } = await createTestWorld();

      const seats = await SeatService.generateSeats(user.id, branch.id, {
        mode: "RANGE",
        ranges: [{ prefix: "A", start: 1, end: 3, separator: "" }],
      });

      expect(seats.map(seat => seat.label)).toEqual(["A1", "A2", "A3"]);
    });

    it("rejects duplicate generated labels without creating a partial batch", async () => {
      const { user, branch } = await createTestWorld();
      await createSeat({ branchId: branch.id, label: "A1" });

      await expect(
        SeatService.generateSeats(user.id, branch.id, {
          mode: "RANGE",
          ranges: [{ prefix: "A", start: 1, end: 3, separator: "" }],
        })
      ).rejects.toThrow(/already exists/i);

      const labels = (await testPrisma.seat.findMany({ where: { branchId: branch.id } }))
        .map(seat => seat.label);
      expect(labels).not.toContain("A2");
      expect(labels).not.toContain("A3");
    });

    it("requires manage_branch access", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });

      await expect(
        SeatService.generateSeats(staffUser.id, branch.id, {
          mode: "SIMPLE",
          count: 2,
        })
      ).rejects.toThrow(/Unauthorized/i);
    });
  });

  // ─── listSeats ─────────────────────────────────────────────────────────────

  describe("listSeats", () => {
    it("returns seats with their active allocations included", async () => {
      const { user, branch, shift } = await createTestWorld();
      const seat = await createSeat({ branchId: branch.id, label: "S1" });
      const student = await createStudent({ branchId: branch.id });
      await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: shift.id });

      const { items: seats } = await SeatService.listSeats(user.id, branch.id);
      const found = seats.find(s => s.id === seat.id);
      expect(found).toBeDefined();
      expect(found!.seatAllocations).toHaveLength(1);
    });

    it("allows STAFF role users to view seat maps", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });
      const seat = await createSeat({ branchId: branch.id, label: "S1" });

      const { items: seats } = await SeatService.listSeats(staffUser.id, branch.id);

      expect(seats.some(s => s.id === seat.id)).toBe(true);
    });

    it("paginates with stable createdAt and id ordering", async () => {
      const { user, branch } = await createTestWorld();
      await testPrisma.seat.updateMany({
        where: { branchId: branch.id },
        data: { createdAt: new Date("2026-01-01T00:00:00.000Z") },
      });
      const createdAt = new Date("2026-02-01T00:00:00.000Z");
      await testPrisma.seat.createMany({
        data: [
          { id: "seat_a", branchId: branch.id, label: "A1", createdAt },
          { id: "seat_b", branchId: branch.id, label: "A2", createdAt },
        ],
      });

      const first = await SeatService.listSeats(user.id, branch.id, { limit: 1 });
      expect(first.items.map(seat => seat.id)).toEqual(["seat_b"]);
      expect(first.nextCursor).not.toBeNull();
      expect(first.total).toBe(3);

      const { decodeDateIdCursor } = await import("@/lib/cursorPagination");
      const second = await SeatService.listSeats(user.id, branch.id, {
        limit: 1,
        cursor: decodeDateIdCursor(first.nextCursor),
      });
      expect(second.items.map(seat => seat.id)).toEqual(["seat_a"]);
    });

    it("excludes ended allocations (endDate ≠ null)", async () => {
      const { user, branch, shift } = await createTestWorld();
      const seat = await createSeat({ branchId: branch.id, label: "S2" });
      const student = await createStudent({ branchId: branch.id });
      // Create an already-ended allocation
      await createAllocation({
        seatId: seat.id,
        studentId: student.id,
        shiftId: shift.id,
        endDate: new Date("2026-01-01"),
      });

      const { items: seats } = await SeatService.listSeats(user.id, branch.id);
      const found = seats.find(s => s.id === seat.id);
      // Ended allocation must not appear in the active list
      expect(found!.seatAllocations).toHaveLength(0);
    });
  });

  // ─── generateOccupancySnapshot ─────────────────────────────────────────────

  describe("generateOccupancySnapshot", () => {
    it("returns 0% when there are no allocations", async () => {
      const { branch } = await createTestWorld();
      // createTestWorld creates 1 seat, 1 shift — no allocations
      const snap = await SeatService.generateOccupancySnapshot(branch.id);
      expect(snap.totalOccupancyPercent).toBe(0);
      expect(snap.totalUsedSlots).toBe(0);
      expect(snap.branchId).toBe(branch.id);
    });

    it("2 shifts × 5 seats × 3 students = correct occupancy math", async () => {
      const { branch } = await createTestWorld();
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });

      // Create 4 more seats (createTestWorld already created 1)
      await Promise.all(
        ["S2", "S3", "S4", "S5"].map(label => createSeat({ branchId: branch.id, label }))
      );

      // Get the original seat from the world
      const seats = await testPrisma.seat.findMany({ where: { branchId: branch.id } });
      expect(seats).toHaveLength(5);

      // Create 3 students and allocate them: 2 in morning, 1 in evening
      const students = await Promise.all([
        createStudent({ branchId: branch.id, name: "A" }),
        createStudent({ branchId: branch.id, name: "B" }),
        createStudent({ branchId: branch.id, name: "C" }),
      ]);
      const morningShift = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });

      await testPrisma.seatAllocation.createMany({
        data: [
          { branchId: branch.id, seatId: seats[0].id, studentId: students[0].id, shiftId: morningShift!.id },
          { branchId: branch.id, seatId: seats[1].id, studentId: students[1].id, shiftId: morningShift!.id },
          { branchId: branch.id, seatId: seats[2].id, studentId: students[2].id, shiftId: evening.id },
        ],
      });

      const snap = await SeatService.generateOccupancySnapshot(branch.id);
      // 5 seats × 2 shifts = 10 total capacity; 3 allocations used
      expect(snap.seatCount).toBe(5);
      expect(snap.shiftCount).toBe(2);
      expect(snap.totalShiftCapacity).toBe(10);
      expect(snap.totalUsedSlots).toBe(3);
      expect(snap.totalOccupancyPercent).toBe(30);
    });

    it("invariant: used ≤ capacity per shift even with corrupted data", async () => {
      const { branch } = await createTestWorld();
      const morningShift = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });

      // Inject 3 allocations when there is only 1 seat (corrupted state)
      const extraStudents = await Promise.all([
        createStudent({ branchId: branch.id, name: "X" }),
        createStudent({ branchId: branch.id, name: "Y" }),
        createStudent({ branchId: branch.id, name: "Z" }),
      ]);
      const seat = await testPrisma.seat.findFirst({ where: { branchId: branch.id } });

      await testPrisma.seatAllocation.createMany({
        data: extraStudents.map(s => ({
          branchId: branch.id,
          seatId: seat!.id,
          studentId: s.id,
          shiftId: morningShift!.id,
        })),
      });

      // Spy on console.warn to verify the invariant guard fires
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const snap = await SeatService.generateOccupancySnapshot(branch.id);

      // Per-shift used must be capped at capacity (1 seat = capacity of 1)
      for (const shiftResult of snap.shifts) {
        expect(shiftResult.used).toBeLessThanOrEqual(shiftResult.capacity);
      }
      // The warning must have been emitted at least once
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // ─── getSeatMap — PRIMARY shift path ────────────────────────────────────────

  describe("getSeatMap — primary shift", () => {
    it("occupied seat shows occupied: true and occupiedBy: studentName", async () => {
      const { user, branch, shift } = await createTestWorld();
      const seat = await createSeat({ branchId: branch.id, label: "T1" });
      const student = await createStudent({ branchId: branch.id, name: "Riya" });
      await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: shift.id });

      const map = await SeatService.getSeatMap(user.id, branch.id, shift.id);
      const entry = map.seats.find(s => s.seatId === seat.id);
      expect(entry!.occupied).toBe(true);
      expect(entry!.occupiedBy).toBe("Riya");
    });

    it("all seats free → all occupied: false", async () => {
      const { user, branch, shift } = await createTestWorld();

      const map = await SeatService.getSeatMap(user.id, branch.id, shift.id);
      expect(map.seats.every(s => s.occupied === false)).toBe(true);
      expect(map.occupiedCount).toBe(0);
    });

    it("time-overlap blocks seat — Morning alloc blocks a Full-Time query", async () => {
      const { user, branch } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      // Full-Time (null/null) overlaps everything
      const fullTime = await createShift({
        branchId: branch.id,
        name: "Full Time",
        startTime: null,
        endTime: null,
      });
      const morning = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });

      const seat = await createSeat({ branchId: branch.id, label: "X1" });
      const student = await createStudent({ branchId: branch.id, name: "Arjun" });
      // Allocate student in Morning
      await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: morning!.id });

      // Query map for Full-Time — should still show seat as occupied
      const map = await SeatService.getSeatMap(user.id, branch.id, fullTime.id);
      const entry = map.seats.find(s => s.seatId === seat.id);
      expect(entry!.occupied).toBe(true);
    });
  });

  // ─── getSeatMap — MULTI-SHIFT path ─────────────────────────────────────────

  describe("getSeatMap — multi-shift", () => {
    it("seat occupied in ANY component shift → blocked in multi-shift map", async () => {
      const { user, branch } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const morning = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });

      // Create multiShift [Morning + Evening]
      const ms = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          price: 0,
          components: {
            create: [
              { shiftId: morning!.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });

      const seat = await createSeat({ branchId: branch.id, label: "M1" });
      const student = await createStudent({ branchId: branch.id });
      // Allocate in Morning only
      await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: morning!.id });

      // Multi-shift map: seat should be occupied because it's taken in a component shift
      const map = await SeatService.getSeatMap(user.id, branch.id, morning!.id, ms.id);
      const entry = map.seats.find(s => s.seatId === seat.id);
      expect(entry!.occupied).toBe(true);
    });

    it("seat free in all component shifts → available in multi-shift map", async () => {
      const { user, branch } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const morning = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });

      const ms = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          price: 0,
          components: {
            create: [
              { shiftId: morning!.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });

      const seat = await createSeat({ branchId: branch.id, label: "M2" });
      // No allocations

      const map = await SeatService.getSeatMap(user.id, branch.id, morning!.id, ms.id);
      const entry = map.seats.find(s => s.seatId === seat.id);
      expect(entry!.occupied).toBe(false);
      expect(entry!.occupiedBy).toBeNull();
    });

    it("blocks active non-component shifts that overlap a component", async () => {
      const { user, branch, shift: morning } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "10:00",
      });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const fullDay = await createShift({
        branchId: branch.id,
        name: "Open all day",
        startTime: null,
        endTime: null,
      });
      const overnight = await createShift({
        branchId: branch.id,
        name: "Overnight",
        startTime: "22:00",
        endTime: "07:00",
      });
      const multiShift = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          price: 0,
          components: {
            create: [
              { shiftId: morning.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });
      const fullDaySeat = await createSeat({ branchId: branch.id, label: "FD" });
      const overnightSeat = await createSeat({ branchId: branch.id, label: "ON" });
      const student = await createStudent({ branchId: branch.id, name: "Conflict" });
      await createAllocation({ seatId: fullDaySeat.id, studentId: student.id, shiftId: fullDay.id });
      await createAllocation({ seatId: overnightSeat.id, studentId: student.id, shiftId: overnight.id });

      const map = await SeatService.getSeatMap(user.id, branch.id, morning.id, multiShift.id);

      expect(map.seats.find(seat => seat.seatId === fullDaySeat.id)?.occupied).toBe(true);
      expect(map.seats.find(seat => seat.seatId === overnightSeat.id)?.occupied).toBe(true);
    });
  });

  // ─── getShiftsCapacity ─────────────────────────────────────────────────────

  describe("getShiftsCapacity", () => {
    it("returns correct used, available, isFull for a fully booked shift", async () => {
      // createTestWorld gives 1 seat + 1 Morning shift
      const { user, branch, shift } = await createTestWorld();
      const seat = await testPrisma.seat.findFirst({ where: { branchId: branch.id } });
      const student = await createStudent({ branchId: branch.id });
      await createAllocation({ seatId: seat!.id, studentId: student.id, shiftId: shift.id });

      const capacities = await SeatService.getShiftsCapacity(user.id, branch.id);
      const morning = capacities.find(c => c.shiftId === shift.id);
      expect(morning!.used).toBe(1);
      expect(morning!.available).toBe(0);
      expect(morning!.isFull).toBe(true);
    });

    it("studentAlreadyAllocated: true when student has overlapping shift", async () => {
      const { user, branch } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      const fullTime = await createShift({
        branchId: branch.id,
        name: "Full Time",
        startTime: null,
        endTime: null,
      });
      const morning = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });

      const seat = await createSeat({ branchId: branch.id, label: "C1" });
      const student = await createStudent({ branchId: branch.id });
      // Allocate student in Morning
      await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: morning!.id });

      const capacities = await SeatService.getShiftsCapacity(user.id, branch.id, student.id);
      const ftEntry = capacities.find(c => c.shiftId === fullTime.id);
      // Full Time overlaps Morning → must be flagged
      expect(ftEntry!.studentAlreadyAllocated).toBe(true);
    });

    it("studentAlreadyAllocated: false for non-overlapping shift", async () => {
      const { user, branch } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const morning = await testPrisma.shift.findFirst({ where: { branchId: branch.id, name: "Morning" } });

      const seat = await createSeat({ branchId: branch.id, label: "C2" });
      const student = await createStudent({ branchId: branch.id });
      await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: morning!.id });

      const capacities = await SeatService.getShiftsCapacity(user.id, branch.id, student.id);
      const eveningEntry = capacities.find(c => c.shiftId === evening.id);
      // Evening does NOT overlap Morning
      expect(eveningEntry!.studentAlreadyAllocated).toBe(false);
    });
  });

  describe("getShiftsCapacityWithMulti", () => {
    it("uses the physical-seat intersection instead of component minimums", async () => {
      const { user, branch, shift: morning, seat: morningSeat } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "10:00",
      });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const eveningSeat = await createSeat({ branchId: branch.id, label: "E1" });
      const morningStudent = await createStudent({ branchId: branch.id, name: "Morning student" });
      const eveningStudent = await createStudent({ branchId: branch.id, name: "Evening student" });
      await createAllocation({ seatId: morningSeat.id, studentId: morningStudent.id, shiftId: morning.id });
      await createAllocation({ seatId: eveningSeat.id, studentId: eveningStudent.id, shiftId: evening.id });
      const multiShift = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          price: 0,
          components: {
            create: [
              { shiftId: morning.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });

      const capacities = await SeatService.getShiftsCapacityWithMulti(user.id, branch.id);
      const fullDay = capacities.find(item => item.multiShiftId === multiShift.id);

      expect(fullDay).toMatchObject({ totalSeats: 2, used: 2, available: 0, isFull: true });
    });

    it("honors excluded allocation IDs in the shared availability calculation", async () => {
      const { user, branch, shift: morning, seat } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "10:00",
      });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const student = await createStudent({ branchId: branch.id });
      const allocation = await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: morning.id });
      const multiShift = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          price: 0,
          components: {
            create: [
              { shiftId: morning.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });

      const capacities = await SeatService.getShiftsCapacityWithMulti(
        user.id,
        branch.id,
        student.id,
        [allocation.id],
      );
      const fullDay = capacities.find(item => item.multiShiftId === multiShift.id);

      expect(fullDay).toMatchObject({ used: 0, available: 1, isFull: false });
      expect(fullDay?.studentAlreadyAllocated).toBe(false);
    });
  });
});
