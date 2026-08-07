import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  isOwner: vi.fn(),
  createBranchForOrg: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/organization.service", () => ({
  OrganizationService: {
    isOwner: mocks.isOwner,
  },
}));

vi.mock("@/services/branch.service", () => ({
  BranchService: {
    createBranchForOrg: mocks.createBranchForOrg,
  },
}));

describe("POST /api/branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function request(body: Record<string, unknown>, idempotencyKey: string | null = "branch-create-1") {
    const headers = new Headers({ "content-type": "application/json" });
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    return new Request("http://test.local/api/branches", {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
  }

  it("returns 401 when no user is signed in", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const { POST } = await import("@/app/api/branches/route");

    const response = await POST(request({ organizationId: "org_1" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.isOwner).not.toHaveBeenCalled();
    expect(mocks.createBranchForOrg).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in user does not own the organization", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "user@test.com" });
    mocks.isOwner.mockResolvedValue(false);
    const { POST } = await import("@/app/api/branches/route");

    const response = await POST(request({
      organizationId: "org_1",
      name: "Second Branch",
      seatCount: 10,
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden: You do not own this organization" });
    expect(mocks.isOwner).toHaveBeenCalledWith("org_1", "user_1");
    expect(mocks.createBranchForOrg).not.toHaveBeenCalled();
  });

  it("creates the branch when the signed-in user owns the organization", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1", email: "owner@test.com" });
    mocks.isOwner.mockResolvedValue(true);
    mocks.createBranchForOrg.mockResolvedValue({ id: "branch_1", name: "Second Branch" });
    const { POST } = await import("@/app/api/branches/route");

    const response = await POST(request({
      organizationId: "org_1",
      name: "Second Branch",
      contactPhone: "9876543210",
      city: "Delhi",
      defaultFee: 1500,
      seatCount: 10,
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "branch_1", name: "Second Branch" });
    expect(mocks.createBranchForOrg).toHaveBeenCalledWith({
      organizationId: "org_1",
      userId: "owner_1",
      name: "Second Branch",
      contactPhone: "+91 98765 43210",
      city: "Delhi",
      defaultFee: 1500,
      seatCount: 10,
      seatNumbering: { mode: "SIMPLE", count: 10 },
      shifts: undefined,
      idempotencyKey: "branch-create-1",
    });
  });

  it("requires an idempotency key before creating a branch", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1", email: "owner@test.com" });
    mocks.isOwner.mockResolvedValue(true);
    const { POST } = await import("@/app/api/branches/route");

    const response = await POST(request({
      organizationId: "org_1",
      name: "Second Branch",
      contactPhone: "9876543210",
      seatCount: 10,
    }, null));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Idempotency-Key is required" });
    expect(mocks.createBranchForOrg).not.toHaveBeenCalled();
  });

  it("passes custom seat numbering to the service", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1", email: "owner@test.com" });
    mocks.isOwner.mockResolvedValue(true);
    mocks.createBranchForOrg.mockResolvedValue({ id: "branch_1", name: "Second Branch" });
    const { POST } = await import("@/app/api/branches/route");

    const seatNumbering = {
      mode: "RANGE",
      ranges: [
        { prefix: "A", start: 1, end: 2, separator: "" },
        { prefix: "B", start: 1, end: 1, separator: "" },
      ],
    };
    const response = await POST(request({
      organizationId: "org_1",
      name: "Second Branch",
      contactPhone: "9876543210",
      seatCount: 3,
      seatNumbering,
    }));

    expect(response.status).toBe(201);
    expect(mocks.createBranchForOrg).toHaveBeenCalledWith(expect.objectContaining({
      seatCount: 3,
      seatNumbering,
    }));
  });
});
