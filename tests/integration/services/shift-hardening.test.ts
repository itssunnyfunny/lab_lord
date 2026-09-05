import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { setTimeout } from "node:timers/promises";
import { ShiftService } from "@/services/shift.service";
import { SeatAllocationService } from "@/services/seatAllocation.service";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import { createTestWorld, createStudent, createShift, createSeat, createAllocation, createBranch } from "@/tests/factories";

describe("shift deactivation boundaries", () => {
  beforeEach(resetDatabase);
  afterAll(disconnectDatabase);

  async function fixture() {
    const world = await createTestWorld();
    const target = await createShift({ branchId: world.branch.id, name: "Evening", startTime: "17:00", endTime: "22:00" });
    const student = await createStudent({ branchId: world.branch.id });
    const allocation = await createAllocation({ seatId: world.seat.id, studentId: student.id, shiftId: world.shift.id });
    return { ...world, target, student, allocation };
  }

  it("rejects foreign targets across organizations and branches with missing-target parity", async () => {
    const a = await fixture();
    const b = await createTestWorld();
    const sibling = await createBranch({ organizationId: a.org.id });
    const siblingShift = await createShift({ branchId: sibling.id });
    for (const targetShiftId of [b.shift.id, siblingShift.id, "missing"]) {
      await expect(ShiftService.deleteShift(a.user.id, a.shift.id, {
        type: "REALLOCATE_BULK", targetShiftId,
      })).rejects.toThrow("Target shift not found or inactive.");
    }
    expect((await testPrisma.seatAllocation.findUniqueOrThrow({ where: { id: a.allocation.id } })).endDate).toBeNull();
    expect((await testPrisma.shift.findUniqueOrThrow({ where: { id: a.shift.id } })).status).toBe("ACTIVE");
  });

  it("rejects missing, duplicate, extra, ended, unrelated, and foreign allocation IDs atomically", async () => {
    const a = await fixture();
    const b = await fixture();
    const ended = await createAllocation({ seatId: a.seat.id, studentId: a.student.id, shiftId: a.shift.id });
    const endedAt = new Date("2026-01-01T00:00:00Z");
    await testPrisma.seatAllocation.update({ where: { id: ended.id }, data: { endDate: endedAt } });
    const unrelated = await createAllocation({ seatId: a.seat.id, studentId: a.student.id, shiftId: a.target.id });
    for (const ids of [[], [a.allocation.id, a.allocation.id], [a.allocation.id, "extra"], [ended.id], [unrelated.id], [b.allocation.id]]) {
      await expect(ShiftService.deleteShift(a.user.id, a.shift.id, {
        type: "REALLOCATE_MANUAL", assignments: ids.map(allocationId => ({ allocationId, targetShiftId: a.target.id })),
      })).rejects.toThrow("Assignments must include every active source allocation exactly once.");
    }
    expect((await testPrisma.seatAllocation.findUniqueOrThrow({ where: { id: ended.id } })).endDate).toEqual(endedAt);
    expect(await testPrisma.seatAllocation.count({ where: { shiftId: a.shift.id, endDate: null } })).toBe(1);
    expect((await testPrisma.shift.findUniqueOrThrow({ where: { id: a.shift.id } })).status).toBe("ACTIVE");
  });

  it("rolls back already-ended source rows when a later assignment cannot fit", async () => {
    const a = await fixture();
    const student2 = await createStudent({ branchId: a.branch.id });
    const seat2 = await createSeat({ branchId: a.branch.id });
    const allocation2 = await createAllocation({ seatId: seat2.id, studentId: student2.id, shiftId: a.shift.id });
    const blocker = await createStudent({ branchId: a.branch.id });
    await createAllocation({ seatId: seat2.id, studentId: blocker.id, shiftId: a.target.id });
    await expect(ShiftService.deleteShift(a.user.id, a.shift.id, {
      type: "REALLOCATE_MANUAL", assignments: [a.allocation.id, allocation2.id].map(allocationId => ({ allocationId, targetShiftId: a.target.id })),
    })).rejects.toThrow(/capacity/i);
    expect(await testPrisma.seatAllocation.count({ where: { shiftId: a.shift.id, endDate: null } })).toBe(2);
    expect(await testPrisma.seatAllocation.count({ where: { shiftId: a.target.id, endDate: null } })).toBe(1);
  });

  it("ends bundle siblings without touching another student's unrelated allocation", async () => {
    const a = await createTestWorld();
    const component = await createShift({ branchId: a.branch.id, name: "Evening", startTime: "17:00", endTime: "22:00" });
    const bundle = await testPrisma.multiShift.create({ data: {
      branchId: a.branch.id, name: "Bundle", price: 1000,
      components: { create: [{ shiftId: a.shift.id, order: 0 }, { shiftId: component.id, order: 1 }] },
    } });
    const student = await createStudent({ branchId: a.branch.id });
    await SeatAllocationService.assignSeatToShifts(a.user.id, a.seat.id, student.id, [a.shift.id, component.id], bundle.id);
    const other = await createStudent({ branchId: a.branch.id });
    const otherSeat = await createSeat({ branchId: a.branch.id });
    await SeatAllocationService.assignSeatToShifts(a.user.id, otherSeat.id, other.id, [component.id]);
    await ShiftService.deleteShift(a.user.id, a.shift.id, { type: "END_ALL" });
    expect(await testPrisma.seatAllocation.count({ where: { studentId: student.id, endDate: null } })).toBe(0);
    expect(await testPrisma.seatAllocation.count({ where: { studentId: other.id, endDate: null } })).toBe(1);
  });

  it("offers and executes reallocation into capacity released by the source bundle", async () => {
    const a = await createTestWorld();
    const target = await createShift({ branchId: a.branch.id, name: "Evening", startTime: "17:00", endTime: "22:00" });
    const bundle = await testPrisma.multiShift.create({ data: {
      branchId: a.branch.id, name: "Bundle", price: 1000,
      components: { create: [{ shiftId: a.shift.id, order: 0 }, { shiftId: target.id, order: 1 }] },
    } });
    const student = await createStudent({ branchId: a.branch.id });
    await SeatAllocationService.assignSeatToShifts(a.user.id, a.seat.id, student.id, [a.shift.id, target.id], bundle.id);
    const analysis = await ShiftService.analyzeShiftDeletion(a.user.id, a.shift.id);
    expect(analysis.otherShifts.find(s => s.shiftId === target.id)?.emptySeats).toBe(1);
    expect(analysis.shiftsWithEnoughCapacity).toContain(target.id);
    await ShiftService.deleteShift(a.user.id, a.shift.id, { type: "REALLOCATE_BULK", targetShiftId: target.id });
    const active = await testPrisma.seatAllocation.findMany({ where: { studentId: student.id, endDate: null } });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ shiftId: target.id, multiShiftId: null });
  });

  it("serializes concurrent allocation and deactivation without leaving an active row on an inactive shift", async () => {
    const a = await fixture();
    const newcomer = await createStudent({ branchId: a.branch.id });
    const seat = await createSeat({ branchId: a.branch.id });
    const outcomes = await Promise.allSettled([
      ShiftService.deleteShift(a.user.id, a.shift.id, { type: "END_ALL" }),
      SeatAllocationService.assignSeatToShifts(a.user.id, seat.id, newcomer.id, [a.shift.id]),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(await testPrisma.seatAllocation.count({ where: { shiftId: a.shift.id, endDate: null } })).toBe(0);
  });

  it("keeps one active shift when the last two are deactivated concurrently", async () => {
    const a = await fixture();
    const results = await Promise.allSettled([a.shift.id, a.target.id].map(id =>
      ShiftService.deleteShift(a.user.id, id, { type: "END_ALL" })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await testPrisma.shift.count({ where: { branchId: a.branch.id, status: "ACTIVE" } })).toBe(1);
  });

  it.each(["END_ALL", "REALLOCATE_MANUAL"] as const)("fences an insert committed after %s reads its source set", async type => {
    const a = await fixture();
    const newcomer = await createStudent({ branchId: a.branch.id });
    const seat = await createSeat({ branchId: a.branch.id });
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query('SELECT id FROM "SeatAllocation" WHERE id=$1 FOR UPDATE', [a.allocation.id]);
    const deletion = ShiftService.deleteShift(a.user.id, a.shift.id, type === "END_ALL"
      ? { type }
      : { type, assignments: [{ allocationId: a.allocation.id, targetShiftId: a.target.id }] })
      .then(() => ({ error: null }), error => ({ error }));
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        const state = await blocker.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%UPDATE%' AND query LIKE '%SeatAllocation%'`);
        if (state.rows[0].n > 0) { waiting = true; break; }
        await setTimeout(20);
      }
      expect(waiting).toBe(true); // Deletion has already read its source predicate.
      await SeatAllocationService.assignSeatToShifts(a.user.id, seat.id, newcomer.id, [a.shift.id]);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    const result = await deletion;
    if (type === "END_ALL") {
      expect(result.error).toBeNull();
      expect(await testPrisma.seatAllocation.count({ where: { shiftId: a.shift.id, endDate: null } })).toBe(0);
    } else {
      expect(result.error?.message).toMatch(/every active source allocation exactly once/);
      expect((await testPrisma.shift.findUniqueOrThrow({ where: { id: a.shift.id } })).status).toBe("ACTIVE");
      expect(await testPrisma.seatAllocation.count({ where: { shiftId: a.shift.id, endDate: null } })).toBe(2);
    }
  });
});
