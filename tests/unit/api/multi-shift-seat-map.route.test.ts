import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  authorize: vi.fn(),
  multiShiftFindUnique: vi.fn(),
  shiftFindMany: vi.fn(),
  seatFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    multiShift: { findUnique: mocks.multiShiftFindUnique },
    shift: { findMany: mocks.shiftFindMany },
    seat: { findMany: mocks.seatFindMany },
  },
}));

const context = {
  params: Promise.resolve({ branchId: "branch_1", multiShiftId: "multi_full" }),
};

describe("GET multi-shift seat map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
    mocks.multiShiftFindUnique.mockResolvedValue({
      id: "multi_full",
      branchId: "branch_1",
      name: "Full Day",
      components: [
        { shiftId: "morning", shift: { id: "morning", startTime: "06:00", endTime: "10:00" } },
        { shiftId: "evening", shift: { id: "evening", startTime: "16:00", endTime: "20:00" } },
      ],
    });
    mocks.shiftFindMany.mockResolvedValue([
      { id: "morning", startTime: "06:00", endTime: "10:00" },
      { id: "evening", startTime: "16:00", endTime: "20:00" },
      { id: "overlap", startTime: "09:00", endTime: "11:00" },
      { id: "full_day", startTime: null, endTime: null },
      { id: "overnight", startTime: "22:00", endTime: "07:00" },
      { id: "night", startTime: "21:00", endTime: "23:00" },
    ]);
    mocks.seatFindMany.mockResolvedValue([
      {
        id: "seat_assigned",
        label: "A1",
        seatAllocations: [{ shiftId: "morning", multiShiftId: "multi_full", student: { name: "Bundle Student" } }],
      },
      {
        id: "seat_child_blocked",
        label: "A2",
        seatAllocations: [{ shiftId: "morning", multiShiftId: null, student: { name: "Morning Student" } }],
      },
      {
        id: "seat_overlap_blocked",
        label: "A3",
        seatAllocations: [{ shiftId: "overlap", multiShiftId: null, student: { name: "Overlap Student" } }],
      },
      {
        id: "seat_available",
        label: "A6",
        seatAllocations: [{ shiftId: "night", multiShiftId: null, student: { name: "Night Student" } }],
      },
      {
        id: "seat_full_day_blocked",
        label: "A4",
        seatAllocations: [{ shiftId: "full_day", multiShiftId: null, student: { name: "Full Day Student" } }],
      },
      {
        id: "seat_overnight_blocked",
        label: "A5",
        seatAllocations: [{ shiftId: "overnight", multiShiftId: null, student: { name: "Overnight Student" } }],
      },
    ]);
  });

  it("distinguishes exact assigned, component/overlap blocked, and available seats", async () => {
    const { GET } = await import("@/app/api/branches/[branchId]/multi-shifts/[multiShiftId]/seat-map/route");

    const response = await GET(new Request("http://test.local"), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      assignedCount: 1,
      blockedCount: 4,
      availableCount: 1,
      occupiedCount: 5,
    });
    expect(body.seats.map((seat: { seatId: string; status: string }) => [seat.seatId, seat.status])).toEqual([
      ["seat_assigned", "ASSIGNED"],
      ["seat_child_blocked", "BLOCKED"],
      ["seat_overlap_blocked", "BLOCKED"],
      ["seat_full_day_blocked", "BLOCKED"],
      ["seat_overnight_blocked", "BLOCKED"],
      ["seat_available", "AVAILABLE"],
    ]);
  });

  it("returns 404 for a missing or cross-branch multi-shift", async () => {
    mocks.multiShiftFindUnique.mockResolvedValue({
      id: "multi_full",
      branchId: "branch_2",
      name: "Full Day",
      components: [],
    });
    const { GET } = await import("@/app/api/branches/[branchId]/multi-shifts/[multiShiftId]/seat-map/route");

    const response = await GET(new Request("http://test.local"), context);

    expect(response.status).toBe(404);
    expect(mocks.seatFindMany).not.toHaveBeenCalled();
  });
});
