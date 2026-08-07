import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  updateStudentProfile: vi.fn(),
  updateStudentStatus: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/student.service", () => ({
  StudentService: {
    updateStudentProfile: mocks.updateStudentProfile,
    updateStudentStatus: mocks.updateStudentStatus,
  },
}));

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
