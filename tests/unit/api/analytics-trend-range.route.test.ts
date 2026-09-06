import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ health: vi.fn(), seat: vi.fn(), payment: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => ({ id: "owner" }) }));
vi.mock("@/services/staff.service", () => ({ StaffService: { authorize: async () => true } }));
vi.mock("@/analytics/trends/branch.trends", () => ({ getBranchHealthTrend: mocks.health }));
vi.mock("@/analytics/trends/seat.trends", () => ({ getSeatUtilizationTrend: mocks.seat }));
vi.mock("@/analytics/trends/payment.trends", () => ({ getPaymentTrend: mocks.payment }));
import { GET } from "@/app/api/analytics/branch/[branchId]/trends/route";

describe("trend route bounds", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["from=2026-02-30&to=2026-03-01", "from=2026-02-01&to=2026-01-01", "from=2000-01-01&to=2026-01-01"])(
    "rejects %s before dispatching any trend query", async query => {
      const response = await GET(new NextRequest(`http://localhost/api/analytics/branch/branch/trends?${query}`),
        { params: Promise.resolve({ branchId: "branch" }) });
      expect(response.status).toBe(400);
      Object.values(mocks).forEach(mock => expect(mock).not.toHaveBeenCalled());
    });
  it("accepts the month-to-date preset", async () => {
    mocks.seat.mockResolvedValue([]);
    const response = await GET(new NextRequest("http://localhost/api/analytics/branch/branch/trends?from=2026-08-01&to=2026-08-31&type=seat"),
      { params: Promise.resolve({ branchId: "branch" }) });
    expect(response.status).toBe(200);
    expect(mocks.seat).toHaveBeenCalledOnce();
  });
});

vi.mock("@/services/accessPolicy.service", () => ({ AccessPolicy: { authorizeCapability: async () => ({}) } }));
