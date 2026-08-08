import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/api/core", () => ({
  apiClient: {
    get: mocks.get,
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

describe("paged API clients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("walks every student page for explicit all-record auxiliary reads", async () => {
    mocks.get
      .mockResolvedValueOnce({ items: [{ id: "student_1" }], nextCursor: "next_1", total: 2 })
      .mockResolvedValueOnce({ items: [{ id: "student_2" }], nextCursor: null, total: 2 });
    const { students } = await import("@/lib/api/students");

    const result = await students.listAll("branch_1", { status: "ACTIVE" });

    expect(result.map(item => item.id)).toEqual(["student_1", "student_2"]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get.mock.calls[1][1].params).toMatchObject({ cursor: "next_1", limit: 100 });
  });

  it("walks every payment page without silently truncating financial summaries", async () => {
    mocks.get
      .mockResolvedValueOnce({ items: [{ id: "payment_1" }], nextCursor: "next_1", total: 2 })
      .mockResolvedValueOnce({ items: [{ id: "payment_2" }], nextCursor: null, total: 2 });
    const { payments } = await import("@/lib/api/payments");

    const result = await payments.listAll("branch_1", { status: "WAIVED", month: "2026-08" });

    expect(result.map(item => item.id)).toEqual(["payment_1", "payment_2"]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get.mock.calls[1][0]).toContain("cursor=next_1");
    expect(mocks.get.mock.calls[1][0]).toContain("limit=100");
  });
});
