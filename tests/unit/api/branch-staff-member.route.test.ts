import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  removeStaff: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: {
    removeStaff: mocks.removeStaff,
  },
}));

describe("DELETE /api/branches/[branchId]/staff/[staffId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1", email: "owner@test.com" });
  });

  const request = new Request("http://test.local/api/branches/branch_1/staff/staff_1", {
    method: "DELETE",
  });
  const context = {
    params: Promise.resolve({ branchId: "branch_1", staffId: "staff_1" }),
  };

  it("returns the same tenant-safe 404 for a missing or foreign staff id", async () => {
    mocks.removeStaff.mockRejectedValue(new Error("Staff member not found"));
    const { DELETE } = await import("@/app/api/branches/[branchId]/staff/[staffId]/route");

    const response = await DELETE(request as never, context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Staff member not found" });
    expect(mocks.removeStaff).toHaveBeenCalledWith("owner_1", "branch_1", "staff_1");
  });

  it("preserves successful same-branch deletion", async () => {
    mocks.removeStaff.mockResolvedValue({ count: 1 });
    const { DELETE } = await import("@/app/api/branches/[branchId]/staff/[staffId]/route");

    const response = await DELETE(request as never, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });
});
