import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBranchDashboardSources } from "@/lib/branchDashboard";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  getStudents: vi.fn(),
}));

vi.mock("@/lib/api/analytics", () => ({
  analytics: { getSnapshot: mocks.getSnapshot },
}));

vi.mock("@/lib/api/branches", () => ({
  branches: { getStudents: mocks.getStudents },
}));

describe("loadBranchDashboardSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStudents.mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async url =>
      Response.json(String(url).includes("seat-allocations")
        ? { items: [], nextCursor: null, total: 0 }
        : [])
    ));
  });

  it("loads the Staff dashboard using reads only", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async url => {
      if (String(url).includes("/payments/overdue")) {
        return Response.json({ items: [], nextCursor: null, total: 0 });
      }
      if (String(url).includes("seat-allocations")) {
        return Response.json({ items: [], nextCursor: null, total: 0 });
      }
      return Response.json(String(url).includes("/payments?")
        ? { items: [], nextCursor: null, total: 0 }
        : []);
    });

    const result = await loadBranchDashboardSources(
      "branch_1",
      {
        analytics: false,
        students: true,
        seat_allocation: true,
        view_payments: true,
      },
      new Date("2026-08-07T10:30:00.000Z")
    );

    expect(result.updatedAt).toBe("2026-08-07T10:30:00.000Z");
    expect(result.resources.analytics).toBe("restricted");
    expect(result.resources.students).toBe("success");
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
    expect(mocks.getStudents).toHaveBeenCalledWith("branch_1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      "/api/branches/branch_1/seat-allocations?activeOnly=true&all=true",
      "/api/branches/branch_1/payments?month=2026-08&all=true",
      "/api/branches/branch_1/payments/overdue?all=true",
    ]);
    expect(fetchMock.mock.calls.every(call => call[1]?.method === undefined)).toBe(true);
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes("payments/ensure"))).toBe(false);
  });

  it("marks a failed resource unavailable instead of treating it as empty", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async url => {
      if (String(url).includes("/payments/overdue")) {
        return Response.json({ error: "offline" }, { status: 503 });
      }
      if (String(url).includes("seat-allocations")) {
        return Response.json({ items: [], nextCursor: null, total: 0 });
      }
      return Response.json(String(url).includes("/payments?")
        ? { items: [], nextCursor: null, total: 0 }
        : []);
    });

    const result = await loadBranchDashboardSources(
      "branch_1",
      {
        analytics: false,
        students: true,
        seat_allocation: true,
        view_payments: true,
      },
      new Date("2026-08-07T10:30:00.000Z")
    );

    expect(result.resources.overdue).toBe("error");
    expect(result.overduePayments).toEqual([]);
  });

  it("accepts legacy list payloads while pagination contracts roll out", async () => {
    const allocation = { startDate: "2026-08-01T00:00:00.000Z" };
    const payment = { id: "payment_1", status: "PAID", dueDate: "2026-08-01", amount: 299 };
    const overdue = {
      paymentId: "payment_2",
      studentId: "student_1",
      studentName: "Asha",
      phone: null,
      dueDate: "2026-07-01",
      amount: 299,
    };
    vi.mocked(fetch).mockImplementation(async url => {
      if (String(url).includes("/payments/overdue")) {
        return Response.json({ count: 1, payments: [overdue] });
      }
      if (String(url).includes("seat-allocations")) {
        return Response.json([allocation]);
      }
      return Response.json([payment]);
    });

    const result = await loadBranchDashboardSources("branch_1", {
      analytics: false,
      students: false,
      seat_allocation: true,
      view_payments: true,
    });

    expect(result.allocations).toEqual([allocation]);
    expect(result.monthPayments).toEqual([payment]);
    expect(result.overduePayments).toEqual([overdue]);
    expect(result.resources.allocations).toBe("success");
    expect(result.resources.payments).toBe("success");
    expect(result.resources.overdue).toBe("success");
  });

  it("does not request resources the viewer cannot access", async () => {
    const fetchMock = vi.mocked(fetch);

    const result = await loadBranchDashboardSources(
      "branch_1",
      {
        analytics: false,
        students: false,
        seat_allocation: false,
        view_payments: false,
      }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getStudents).not.toHaveBeenCalled();
    expect(result.resources).toEqual({
      analytics: "restricted",
      students: "restricted",
      allocations: "restricted",
      payments: "restricted",
      overdue: "restricted",
    });
  });
});
