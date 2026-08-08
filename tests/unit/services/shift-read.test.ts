import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  branchFindUnique: vi.fn(),
  shiftFindMany: vi.fn(),
  ensureDefaults: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    branch: { findUnique: mocks.branchFindUnique },
    shift: { findMany: mocks.shiftFindMany },
  },
}));
vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));
vi.mock("@/services/defaultShifts", () => ({
  DEFAULT_PRIMARY_SHIFTS: [],
  ensureDefaultShiftsAndFullTime: mocks.ensureDefaults,
}));

describe("ShiftService.listShifts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(true);
    mocks.branchFindUnique.mockResolvedValue({ id: "branch_1" });
    mocks.shiftFindMany.mockResolvedValue([]);
  });

  it("is a read-only operation and never creates default shifts", async () => {
    const { ShiftService } = await import("@/services/shift.service");

    await expect(ShiftService.listShifts("user_1", "branch_1")).resolves.toEqual([]);

    expect(mocks.ensureDefaults).not.toHaveBeenCalled();
    expect(mocks.shiftFindMany).toHaveBeenCalledWith({
      where: { branchId: "branch_1", status: "ACTIVE" },
      orderBy: { name: "asc" },
    });
  });
});
