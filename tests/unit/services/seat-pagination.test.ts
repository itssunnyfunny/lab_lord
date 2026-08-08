import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeatService } from "@/services/seat.service";
import { SeatAllocationService } from "@/services/seatAllocation.service";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  branchFindUnique: vi.fn(),
  seatFindMany: vi.fn(),
  seatCount: vi.fn(),
  allocationFindMany: vi.fn(),
  allocationCount: vi.fn(),
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    branch: { findUnique: mocks.branchFindUnique },
    seat: {
      findMany: mocks.seatFindMany,
      count: mocks.seatCount,
    },
    seatAllocation: {
      findMany: mocks.allocationFindMany,
      count: mocks.allocationCount,
    },
  },
}));

const firstDate = new Date("2026-08-08T10:00:00.000Z");
const secondDate = new Date("2026-08-08T09:00:00.000Z");

describe("seat list service pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(undefined);
    mocks.branchFindUnique.mockResolvedValue({ id: "branch_1" });
    mocks.seatCount.mockResolvedValue(2);
    mocks.allocationCount.mockResolvedValue(2);
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
});
