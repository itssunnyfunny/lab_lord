import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  reactivateArchivedBranch: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/branch.service", () => ({
  BranchService: {
    reactivateArchivedBranch: mocks.reactivateArchivedBranch,
  },
}));

describe("POST /api/branches/[branchId]/billing/reactivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1" });
  });

  it("requires an idempotency key", async () => {
    const { POST } = await import("@/app/api/branches/[branchId]/billing/reactivate/route");
    const response = await POST(
      new Request("http://test.local/api/branches/branch_1/billing/reactivate", { method: "POST" }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Idempotency-Key is required" });
    expect(mocks.reactivateArchivedBranch).not.toHaveBeenCalled();
  });

  it("passes the caller's stable idempotency key to the service", async () => {
    mocks.reactivateArchivedBranch.mockResolvedValue({
      change: { id: "change_1" },
      processingUrl: "/org/org_1/billing/processing/change_1",
    });
    const { POST } = await import("@/app/api/branches/[branchId]/billing/reactivate/route");
    const response = await POST(
      new Request("http://test.local/api/branches/branch_1/billing/reactivate", {
        method: "POST",
        headers: { "Idempotency-Key": "reactivate-1" },
      }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(response.status).toBe(202);
    expect(mocks.reactivateArchivedBranch).toHaveBeenCalledWith("owner_1", "branch_1", "reactivate-1");
  });
});
