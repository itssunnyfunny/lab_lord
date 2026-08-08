import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeDateIdCursor } from "@/lib/cursorPagination";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  listSeats: vi.fn(),
  listAllocations: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/seat.service", () => ({
  SeatService: { listSeats: mocks.listSeats },
}));

vi.mock("@/services/seatAllocation.service", () => ({
  SeatAllocationService: { listAllocations: mocks.listAllocations },
}));

const context = { params: Promise.resolve({ branchId: "branch_1" }) };

describe("branch seat pagination routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
    mocks.listSeats.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    mocks.listAllocations.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
  });

  it.each(["0", "101", "1.5", "invalid"])(
    "returns 400 for invalid seat limit %s",
    async limit => {
      const { GET } = await import("@/app/api/branches/[branchId]/seats/route");
      const request = new NextRequest(`http://test.local/api/branches/branch_1/seats?limit=${limit}`);

      const response = await GET(request, context);

      expect(response.status).toBe(400);
      expect(mocks.listSeats).not.toHaveBeenCalled();
    }
  );

  it("decodes a seat cursor and forwards the bounded page", async () => {
    const cursor = encodeDateIdCursor({ sort: "2026-08-08T00:00:00.000Z", id: "seat_1" });
    const { GET } = await import("@/app/api/branches/[branchId]/seats/route");
    const request = new NextRequest(
      `http://test.local/api/branches/branch_1/seats?cursor=${cursor}&limit=25&shiftId=shift_1`
    );

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(mocks.listSeats).toHaveBeenCalledWith("user_1", "branch_1", {
      shiftId: "shift_1",
      cursor: { sort: new Date("2026-08-08T00:00:00.000Z"), id: "seat_1" },
      limit: 25,
      all: false,
    });
  });

  it("returns 400 for a malformed seat cursor", async () => {
    const { GET } = await import("@/app/api/branches/[branchId]/seats/route");
    const request = new NextRequest("http://test.local/api/branches/branch_1/seats?cursor=not-a-cursor");

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect(mocks.listSeats).not.toHaveBeenCalled();
  });

  it("rejects pagination parameters combined with all=true", async () => {
    const { GET } = await import("@/app/api/branches/[branchId]/seats/route");
    const request = new NextRequest("http://test.local/api/branches/branch_1/seats?all=true&limit=50");

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "all cannot be combined with cursor or limit" });
  });

  it("validates allocation status before calling the service", async () => {
    const { GET } = await import("@/app/api/branches/[branchId]/seat-allocations/route");
    const request = new NextRequest(
      "http://test.local/api/branches/branch_1/seat-allocations?status=UNKNOWN"
    );

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect(mocks.listAllocations).not.toHaveBeenCalled();
  });

  it("decodes an allocation cursor and forwards status filters", async () => {
    const cursor = encodeDateIdCursor({ sort: "2026-08-07T00:00:00.000Z", id: "allocation_1" });
    const { GET } = await import("@/app/api/branches/[branchId]/seat-allocations/route");
    const request = new NextRequest(
      `http://test.local/api/branches/branch_1/seat-allocations?status=ENDED&cursor=${cursor}&limit=10`
    );

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(mocks.listAllocations).toHaveBeenCalledWith(
      "user_1",
      "branch_1",
      { studentId: undefined, shiftId: undefined, activeOnly: false, status: "ENDED" },
      {
        cursor: { sort: new Date("2026-08-07T00:00:00.000Z"), id: "allocation_1" },
        limit: 10,
        all: false,
      }
    );
  });

  it("returns 400 for a malformed allocation cursor", async () => {
    const { GET } = await import("@/app/api/branches/[branchId]/seat-allocations/route");
    const request = new NextRequest(
      "http://test.local/api/branches/branch_1/seat-allocations?cursor=not-a-cursor"
    );

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect(mocks.listAllocations).not.toHaveBeenCalled();
  });

  it("supports explicit complete allocation reads", async () => {
    const { GET } = await import("@/app/api/branches/[branchId]/seat-allocations/route");
    const request = new NextRequest(
      "http://test.local/api/branches/branch_1/seat-allocations?activeOnly=true&all=true"
    );

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(mocks.listAllocations).toHaveBeenCalledWith(
      "user_1",
      "branch_1",
      { studentId: undefined, shiftId: undefined, activeOnly: true, status: undefined },
      { cursor: null, limit: 50, all: true }
    );
  });
});
