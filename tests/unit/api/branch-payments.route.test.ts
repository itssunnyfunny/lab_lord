import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  listPayments: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/payment.service", () => ({
  PaymentService: {
    listPayments: mocks.listPayments,
  },
}));

describe("GET /api/branches/[branchId]/payments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "staff_1", email: "staff@test.com" });
  });

  const context = { params: Promise.resolve({ branchId: "branch_1" }) };

  it("validates filters and forwards explicit pagination", async () => {
    const result = { items: [{ id: "payment_1" }], nextCursor: null, total: 1 };
    mocks.listPayments.mockResolvedValue(result);
    const request = new Request(
      "http://test.local/api/branches/branch_1/payments?status=PAID&month=2026-08&limit=25"
    );
    const { GET } = await import("@/app/api/branches/[branchId]/payments/route");

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.listPayments).toHaveBeenCalledWith(
      "staff_1",
      "branch_1",
      "PAID",
      new Date("2026-08-01T12:00:00.000Z"),
      { limit: 25, cursor: null }
    );
  });

  it("supports explicit complete dashboard reads without changing response shape", async () => {
    const items = [{ id: "payment_1" }, { id: "payment_2" }];
    mocks.listPayments.mockResolvedValue(items);
    const request = new Request(
      "http://test.local/api/branches/branch_1/payments?month=2026-08&all=true"
    );
    const { GET } = await import("@/app/api/branches/[branchId]/payments/route");

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items, nextCursor: null, total: 2 });
    expect(mocks.listPayments).toHaveBeenCalledWith(
      "staff_1",
      "branch_1",
      undefined,
      new Date("2026-08-01T12:00:00.000Z")
    );
  });

  it.each([
    ["status=FORGED", "Invalid payment status"],
    ["month=2026-13", "month must use YYYY-MM"],
    ["limit=0", "limit must be between 1 and 100"],
    ["cursor=not-a-cursor", "cursor is invalid"],
    ["all=maybe", "all must be true or false"],
    ["all=true&cursor=not-a-cursor", "all cannot be combined with cursor or limit"],
  ])("returns 400 for invalid input %s", async (query, message) => {
    const request = new Request(`http://test.local/api/branches/branch_1/payments?${query}`);
    const { GET } = await import("@/app/api/branches/[branchId]/payments/route");

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(mocks.listPayments).not.toHaveBeenCalled();
  });
});
