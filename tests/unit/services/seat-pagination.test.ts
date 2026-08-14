import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeatService } from "@/services/seat.service";
import { SeatAllocationService } from "@/services/seatAllocation.service";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getBranchAccess: vi.fn(),
  branchFindUnique: vi.fn(),
  studentFindFirst: vi.fn(),
  seatFindMany: vi.fn(),
  seatCount: vi.fn(),
  shiftFindMany: vi.fn(),
  allocationFindMany: vi.fn(),
  allocationCount: vi.fn(),
  multiShiftFindUnique: vi.fn(),
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: {
    authorize: mocks.authorize,
    getBranchAccess: mocks.getBranchAccess,
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    branch: { findUnique: mocks.branchFindUnique },
    student: { findFirst: mocks.studentFindFirst },
    seat: {
      findMany: mocks.seatFindMany,
      count: mocks.seatCount,
    },
    shift: { findMany: mocks.shiftFindMany },
    seatAllocation: {
      findMany: mocks.allocationFindMany,
      count: mocks.allocationCount,
    },
    multiShift: { findUnique: mocks.multiShiftFindUnique },
  },
}));

const firstDate = new Date("2026-08-08T10:00:00.000Z");
const secondDate = new Date("2026-08-08T09:00:00.000Z");

describe("seat list service pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(undefined);
    mocks.getBranchAccess.mockResolvedValue({ permissions: { students: true } });
    mocks.branchFindUnique.mockResolvedValue({ id: "branch_1" });
    mocks.studentFindFirst.mockResolvedValue({ id: "student_1" });
    mocks.seatCount.mockResolvedValue(2);
    mocks.shiftFindMany.mockResolvedValue([]);
    mocks.allocationCount.mockResolvedValue(2);
    mocks.multiShiftFindUnique.mockResolvedValue({ branchId: "branch_1" });
  });

  it("returns a bounded seat page with a stable look-ahead cursor", async () => {
    mocks.seatFindMany.mockResolvedValue([
      { id: "seat_2", createdAt: firstDate, seatAllocations: [] },
      { id: "seat_1", createdAt: secondDate, seatAllocations: [] },
    ]);

    const page = await SeatService.listSeats("user_1", "branch_1", { limit: 1 });

    expect(page.items.map(seat => seat.id)).toEqual(["seat_2"]);
    expect(page.nextCursor).not.toBeNull();
    expect(page.total).toBe(2);
    expect(mocks.seatFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
  });

  it("applies the date/id boundary to the next seat page", async () => {
    mocks.seatFindMany.mockResolvedValue([]);

    await SeatService.listSeats("user_1", "branch_1", {
      cursor: { sort: firstDate, id: "seat_2" },
      limit: 25,
    });

    expect(mocks.seatFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        branchId: "branch_1",
        OR: [
          { createdAt: { lt: firstDate } },
          { createdAt: firstDate, id: { lt: "seat_2" } },
        ],
      },
      take: 26,
    }));
  });

  it("filters allocation pages by status and applies the date/id boundary", async () => {
    mocks.allocationFindMany.mockResolvedValue([]);

    await SeatAllocationService.listAllocations(
      "user_1",
      "branch_1",
      { status: "ENDED", studentId: "student_1" },
      { cursor: { sort: firstDate, id: "allocation_2" }, limit: 10 }
    );

    expect(mocks.allocationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        seat: { branchId: "branch_1" },
        studentId: "student_1",
        shiftId: undefined,
        multiShiftId: undefined,
        endDate: { not: null },
        OR: [
          { startDate: { lt: firstDate } },
          { startDate: firstDate, id: { lt: "allocation_2" } },
        ],
      },
      take: 11,
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
    }));
  });

  it("filters active and ended pages by the exact multi-shift before pagination", async () => {
    mocks.allocationFindMany.mockResolvedValue([]);

    await SeatAllocationService.listAllocations(
      "user_1",
      "branch_1",
      { status: "ENDED", multiShiftId: "multi_full" },
      { limit: 10 }
    );

    expect(mocks.multiShiftFindUnique).toHaveBeenCalledWith({
      where: { id: "multi_full" },
      select: { branchId: true },
    });
    expect(mocks.allocationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        multiShiftId: "multi_full",
        endDate: { not: null },
      }),
      take: 11,
    }));
  });

  it("rejects a cross-branch multi-shift allocation filter", async () => {
    mocks.multiShiftFindUnique.mockResolvedValue({ branchId: "branch_2" });

    await expect(SeatAllocationService.listAllocations(
      "user_1",
      "branch_1",
      { multiShiftId: "multi_other" }
    )).rejects.toThrow("Multi-shift not found");

    expect(mocks.allocationFindMany).not.toHaveBeenCalled();
  });

  it("returns an explicit complete allocation result without a cursor", async () => {
    const rows = [
      { id: "allocation_2", startDate: firstDate },
      { id: "allocation_1", startDate: secondDate },
    ];
    mocks.allocationFindMany.mockResolvedValue(rows);

    const page = await SeatAllocationService.listAllocations(
      "user_1",
      "branch_1",
      { activeOnly: true },
      { all: true }
    );

    expect(page).toEqual({ items: rows, nextCursor: null, total: 2 });
    expect(mocks.allocationFindMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() })
    );
  });

  it("projects only minimal student identity without students permission", async () => {
    mocks.getBranchAccess.mockResolvedValue({ permissions: { students: false } });
    mocks.seatFindMany.mockResolvedValue([]);
    mocks.allocationFindMany.mockResolvedValue([]);

    await SeatService.listSeats("user_1", "branch_1");
    await SeatAllocationService.listAllocations("user_1", "branch_1");

    const seatQuery = mocks.seatFindMany.mock.calls[0][0];
    const allocationQuery = mocks.allocationFindMany.mock.calls[0][0];
    expect(seatQuery.include.seatAllocations.include.student).toEqual({
      select: { id: true, name: true },
    });
    expect(allocationQuery.include.student).toEqual({
      select: { id: true, name: true },
    });
    expect(allocationQuery.include.student).not.toBe(true);
  });

  it("preserves explicit richer student fields with students permission", async () => {
    mocks.seatFindMany.mockResolvedValue([]);
    mocks.allocationFindMany.mockResolvedValue([]);

    await SeatService.listSeats("user_1", "branch_1");
    await SeatAllocationService.listAllocations("user_1", "branch_1");

    const seatStudentSelect = mocks.seatFindMany.mock.calls[0][0]
      .include.seatAllocations.include.student.select;
    const allocationStudentSelect = mocks.allocationFindMany.mock.calls[0][0]
      .include.student.select;
    expect(seatStudentSelect).toEqual({
      id: true,
      name: true,
      phone: true,
      status: true,
      monthlyFee: true,
    });
    expect(allocationStudentSelect).toEqual({
      id: true,
      branchId: true,
      name: true,
      phone: true,
      status: true,
      joinedAt: true,
      billingStartAt: true,
      monthlyFee: true,
      feeLinkedShiftId: true,
      feeLinkedMultiShiftId: true,
      createdAt: true,
      updatedAt: true,
    });
  });

  it("rejects a foreign-branch capacity student before it influences results", async () => {
    mocks.studentFindFirst.mockResolvedValue(null);

    await expect(SeatService.getShiftsCapacityWithMulti(
      "user_1",
      "branch_1",
      "student_foreign"
    )).rejects.toThrow("Student not found");

    expect(mocks.studentFindFirst).toHaveBeenCalledWith({
      where: { id: "student_foreign", branchId: "branch_1" },
      select: { id: true },
    });
    expect(mocks.seatFindMany).not.toHaveBeenCalled();
    expect(mocks.shiftFindMany).not.toHaveBeenCalled();
    expect(mocks.allocationFindMany).not.toHaveBeenCalled();
  });

  it("uses a same-branch capacity student with branch-scoped allocation defense", async () => {
    mocks.studentFindFirst.mockResolvedValue({ id: "student_1" });
    mocks.seatFindMany.mockResolvedValue([]);
    mocks.shiftFindMany.mockResolvedValue([{
      id: "shift_1",
      name: "Morning",
      startTime: "06:00",
      endTime: "10:00",
      price: 100,
      isReserved: false,
    }]);
    mocks.allocationFindMany.mockResolvedValue([{
      shiftId: "shift_1",
      shift: { id: "shift_1", startTime: "06:00", endTime: "10:00" },
    }]);

    const capacity = await SeatService.getShiftsCapacity(
      "user_1",
      "branch_1",
      "student_1"
    );

    expect(capacity).toEqual([
      expect.objectContaining({
        shiftId: "shift_1",
        studentAlreadyAllocated: true,
      }),
    ]);

    expect(mocks.studentFindFirst).toHaveBeenCalledWith({
      where: { id: "student_1", branchId: "branch_1" },
      select: { id: true },
    });
    expect(mocks.allocationFindMany).toHaveBeenCalledWith({
      where: {
        studentId: "student_1",
        student: { branchId: "branch_1" },
        seat: { branchId: "branch_1" },
        endDate: null,
      },
      include: {
        shift: { select: { id: true, startTime: true, endTime: true } },
      },
    });
  });
});
