import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  branchFindUnique: vi.fn(),
  studentFindMany: vi.fn(),
  studentCount: vi.fn(),
  multiShiftFindUnique: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    branch: { findUnique: mocks.branchFindUnique },
    student: {
      findMany: mocks.studentFindMany,
      count: mocks.studentCount,
    },
    multiShift: { findUnique: mocks.multiShiftFindUnique },
    payment: {
      findMany: mocks.paymentFindMany,
      count: mocks.paymentCount,
    },
  },
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));

describe("high-volume list service pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.branchFindUnique.mockResolvedValue({ id: "branch_1" });
    mocks.multiShiftFindUnique.mockResolvedValue({ branchId: "branch_1" });
  });

  it("filters students by exact active multi-shift allocation", async () => {
    mocks.studentFindMany.mockResolvedValue([]);
    const { StudentService } = await import("@/services/student.service");

    await StudentService.getStudentsByBranch("user_1", "branch_1", {
      multiShiftId: "multi_full",
    });

    expect(mocks.multiShiftFindUnique).toHaveBeenCalledWith({
      where: { id: "multi_full" },
      select: { branchId: true },
    });
    expect(mocks.studentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        seatAllocations: {
          some: { multiShiftId: "multi_full", endDate: null },
        },
      }),
    }));
  });

  it("rejects a cross-branch multi-shift student filter", async () => {
    mocks.multiShiftFindUnique.mockResolvedValue({ branchId: "branch_2" });
    const { StudentService } = await import("@/services/student.service");

    await expect(StudentService.getStudentsByBranch("user_1", "branch_1", {
      multiShiftId: "multi_other",
    })).rejects.toThrow("Multi-shift not found");
    expect(mocks.studentFindMany).not.toHaveBeenCalled();
  });

  it("pages students by createdAt and id while preserving array defaults for internal callers", async () => {
    const first = { id: "student_2", createdAt: new Date("2026-08-02T00:00:00.000Z") };
    const second = { id: "student_1", createdAt: new Date("2026-08-01T00:00:00.000Z") };
    mocks.studentFindMany.mockResolvedValueOnce([first, second]);
    mocks.studentCount.mockResolvedValueOnce(2);
    const { StudentService } = await import("@/services/student.service");

    const page = await StudentService.getStudentsByBranch("user_1", "branch_1", {
      status: "ACTIVE",
      limit: 1,
      cursor: null,
    });

    expect(page.items).toEqual([first]);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(mocks.studentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    }));

    mocks.studentFindMany.mockResolvedValueOnce([first]);
    const all = await StudentService.getStudentsByBranch("user_1", "branch_1", { status: "ACTIVE" });
    expect(all).toEqual([first]);
    expect(mocks.studentFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }));
  });

  it("pages payments by dueDate and id while preserving unbounded explicit service reads", async () => {
    const first = { id: "payment_1", dueDate: new Date("2026-08-01T00:00:00.000Z") };
    const second = { id: "payment_2", dueDate: new Date("2026-08-02T00:00:00.000Z") };
    mocks.paymentFindMany.mockResolvedValueOnce([first, second]);
    mocks.paymentCount.mockResolvedValueOnce(2);
    const { PaymentService } = await import("@/services/payment.service");

    const page = await PaymentService.listPayments(
      "user_1",
      "branch_1",
      "DUE",
      undefined,
      { limit: 1, cursor: null }
    );

    expect(page.items).toEqual([first]);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(mocks.paymentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: 2,
    }));

    mocks.paymentFindMany.mockResolvedValueOnce([first]);
    const all = await PaymentService.listPayments("user_1", "branch_1", "DUE");
    expect(all).toEqual([first]);
    expect(mocks.paymentFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    }));
  });
});
