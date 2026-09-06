import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import { createTestWorld, createStudent, createBranch, createShift } from "@/tests/factories";

describe("PostgreSQL allocation tenant constraints", () => {
  beforeEach(resetDatabase);
  afterAll(disconnectDatabase);

  it("rejects each foreign relationship directly and preserves a legitimate allocation", async () => {
    const a = await createTestWorld();
    const b = await createTestWorld();
    const studentA = await createStudent({ branchId: a.branch.id });
    const studentB = await createStudent({ branchId: b.branch.id });
    const bundleB = await testPrisma.multiShift.create({ data: { branchId: b.branch.id, name: "Foreign", price: 100 } });
    const sibling = await createBranch({ organizationId: a.org.id });
    const siblingShift = await createShift({ branchId: sibling.id });
    const valid = { branchId: a.branch.id, seatId: a.seat.id, studentId: studentA.id, shiftId: a.shift.id };
    for (const override of [
      { seatId: b.seat.id }, { studentId: studentB.id }, { shiftId: b.shift.id },
      { shiftId: siblingShift.id }, { multiShiftId: bundleB.id }, { branchId: b.branch.id },
    ]) {
      await expect(testPrisma.seatAllocation.create({ data: { ...valid, ...override } }))
        .rejects.toMatchObject({ code: "P2003" });
    }
    const allocation = await testPrisma.seatAllocation.create({ data: valid });
    await expect(testPrisma.seatAllocation.update({ where: { id: allocation.id }, data: { shiftId: b.shift.id } }))
      .rejects.toMatchObject({ code: "P2003" });
    expect(await testPrisma.seatAllocation.count()).toBe(1);
    expect((await testPrisma.seatAllocation.findUniqueOrThrow({ where: { id: allocation.id } })).shiftId).toBe(a.shift.id);
  });
});
