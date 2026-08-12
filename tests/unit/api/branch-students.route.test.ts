import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getStudentsByBranch: vi.fn(),
  updateStudentProfile: vi.fn(),
  updateStudentStatus: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/student.service", () => ({
  StudentService: {
    getStudentsByBranch: mocks.getStudentsByBranch,
    updateStudentProfile: mocks.updateStudentProfile,
    updateStudentStatus: mocks.updateStudentStatus,
  },
}));

describe("GET /api/branches/[branchId]/students", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "staff_1", email: "staff@test.com" });
  });

  const context = { params: Promise.resolve({ branchId: "branch_1" }) };

  it("uses the default page size and returns a paged result", async () => {
    const result = { items: [{ id: "student_1" }], nextCursor: null, total: 1 };
    mocks.getStudentsByBranch.mockResolvedValue(result);
    const request = new NextRequest(
      "http://test.local/api/branches/branch_1/students?status=ACTIVE&shiftId=shift_1&q=asha"
    );
    const { GET } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.getStudentsByBranch).toHaveBeenCalledWith("staff_1", "branch_1", {
      status: "ACTIVE",
      shiftId: "shift_1",
      multiShiftId: undefined,
      query: "asha",
      limit: 50,
      cursor: null,
    });
  });

  it("keeps explicit complete reads inside the PagedResult contract", async () => {
    const items = [{ id: "student_1" }, { id: "student_2" }];
    mocks.getStudentsByBranch.mockResolvedValue(items);
    const request = new NextRequest(
      "http://test.local/api/branches/branch_1/students?status=ACTIVE&all=true"
    );
    const { GET } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items, nextCursor: null, total: 2 });
    expect(mocks.getStudentsByBranch).toHaveBeenCalledWith("staff_1", "branch_1", {
      status: "ACTIVE",
      shiftId: undefined,
      multiShiftId: undefined,
      query: undefined,
    });
  });

  it("forwards an exact multi-shift filter", async () => {
    mocks.getStudentsByBranch.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    const request = new NextRequest(
      "http://test.local/api/branches/branch_1/students?multiShiftId=multi_full"
    );
    const { GET } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(mocks.getStudentsByBranch).toHaveBeenCalledWith("staff_1", "branch_1", {
      status: undefined,
      shiftId: undefined,
      multiShiftId: "multi_full",
      query: undefined,
      limit: 50,
      cursor: null,
    });
  });

  it("rejects primary and multi-shift filters together", async () => {
    const request = new NextRequest(
      "http://test.local/api/branches/branch_1/students?shiftId=morning&multiShiftId=multi_full"
    );
    const { GET } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "shiftId and multiShiftId cannot be combined" });
    expect(mocks.getStudentsByBranch).not.toHaveBeenCalled();
  });

  it("returns 404 when the requested multi-shift is missing or belongs to another branch", async () => {
    mocks.getStudentsByBranch.mockRejectedValue(new Error("Multi-shift not found"));
    const request = new NextRequest(
      "http://test.local/api/branches/branch_1/students?multiShiftId=missing"
    );
    const { GET } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await GET(request, context);

    expect(response.status).toBe(404);
  });

  it.each([
    ["limit=0", "limit must be between 1 and 100"],
    ["limit=101", "limit must be between 1 and 100"],
    ["cursor=not-a-cursor", "cursor is invalid"],
    ["all=maybe", "all must be true or false"],
    ["all=true&limit=50", "all cannot be combined with cursor or limit"],
  ])("returns 400 for invalid pagination input %s", async (query, message) => {
    const request = new NextRequest(`http://test.local/api/branches/branch_1/students?${query}`);
    const { GET } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(mocks.getStudentsByBranch).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/branches/[branchId]/students", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "staff_1", email: "staff@test.com" });
  });

  it("returns 400 for an invalid dueResolution without invoking the service", async () => {
    const request = new NextRequest("http://test.local/api/branches/branch_1/students", {
      method: "PATCH",
      body: JSON.stringify({
        id: "student_1",
        status: "INACTIVE",
        dueResolution: "FORGED",
      }),
      headers: { "content-type": "application/json" },
    });
    const { PATCH } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await PATCH(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid due resolution" });
    expect(mocks.updateStudentStatus).not.toHaveBeenCalled();
    expect(mocks.updateStudentProfile).not.toHaveBeenCalled();
  });

  it("rejects a non-string dueResolution instead of treating it as KEEP", async () => {
    const request = new NextRequest("http://test.local/api/branches/branch_1/students", {
      method: "PATCH",
      body: JSON.stringify({
        id: "student_1",
        status: "INACTIVE",
        dueResolution: null,
      }),
      headers: { "content-type": "application/json" },
    });
    const { PATCH } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await PATCH(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid due resolution" });
    expect(mocks.updateStudentStatus).not.toHaveBeenCalled();
  });

  it("keeps the existing KEEP default when dueResolution is omitted", async () => {
    const student = { id: "student_1", status: "INACTIVE" };
    mocks.updateStudentStatus.mockResolvedValue(student);
    const request = new NextRequest("http://test.local/api/branches/branch_1/students", {
      method: "PATCH",
      body: JSON.stringify({
        id: "student_1",
        status: "INACTIVE",
      }),
      headers: { "content-type": "application/json" },
    });
    const { PATCH } = await import("@/app/api/branches/[branchId]/students/route");

    const response = await PATCH(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(student);
    expect(mocks.updateStudentStatus).toHaveBeenCalledWith(
      "staff_1",
      "student_1",
      "INACTIVE",
      "KEEP"
    );
  });
});
