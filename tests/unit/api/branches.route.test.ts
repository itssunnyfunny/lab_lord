import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationAccessNotFoundError } from "@/lib/organizationErrors";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getOrganizationForOwnerAccess: vi.fn(),
  createBranchForOrg: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/organization.service", () => ({
  OrganizationService: {
    getOrganizationForOwnerAccess: mocks.getOrganizationForOwnerAccess,
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
    expect(mocks.getOrganizationForOwnerAccess).not.toHaveBeenCalled();
    expect(mocks.createBranchForOrg).not.toHaveBeenCalled();
  });

  it("returns the generic 404 when the signed-in user does not own the organization", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "user@test.com" });
    mocks.getOrganizationForOwnerAccess.mockRejectedValue(new OrganizationAccessNotFoundError());
    const { POST } = await import("@/app/api/branches/route");

    const response = await POST(request({
      organizationId: "org_1",
      name: "Second Branch",
      seatCount: 10,
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Organization not found" });
    expect(mocks.getOrganizationForOwnerAccess).toHaveBeenCalledWith("org_1", "user_1");
    expect(mocks.createBranchForOrg).not.toHaveBeenCalled();
  });

  it("creates the branch when the signed-in user owns the organization", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1", email: "owner@test.com" });
    mocks.getOrganizationForOwnerAccess.mockResolvedValue({ id: "org_1" });
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
    mocks.getOrganizationForOwnerAccess.mockResolvedValue({ id: "org_1" });
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
    mocks.getOrganizationForOwnerAccess.mockResolvedValue({ id: "org_1" });
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
