import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReadOnlyError } from "@/services/entitlement.service";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getOrganizationForOwnerAccess: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/organization.service", () => ({
  OrganizationService: {
    getOrganizationForOwnerAccess: mocks.getOrganizationForOwnerAccess,
    updateSettings: mocks.updateSettings,
  },
}));

describe("/api/organizations/[orgId] settings access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1" });
  });

  it("uses owner read access for GET without requiring a writable workspace", async () => {
    mocks.getOrganizationForOwnerAccess.mockResolvedValue({ id: "org_1", name: "Lab Lords" });
    const { GET } = await import("@/app/api/organizations/[orgId]/route");

    const response = await GET(
      new Request("http://test.local/api/organizations/org_1") as never,
      { params: Promise.resolve({ orgId: "org_1" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "org_1", name: "Lab Lords" });
    expect(mocks.getOrganizationForOwnerAccess).toHaveBeenCalledWith("org_1", "owner_1");
  });

  it("returns a typed 403 when billing makes a PATCH read-only", async () => {
    mocks.updateSettings.mockRejectedValue(
      new BillingReadOnlyError("Workspace access is read-only until billing is restored")
    );
    const { PATCH } = await import("@/app/api/organizations/[orgId]/route");

    const response = await PATCH(
      new Request("http://test.local/api/organizations/org_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      }) as never,
      { params: Promise.resolve({ orgId: "org_1" }) }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Unauthorized: Workspace access is read-only until billing is restored",
      code: "BILLING_READ_ONLY",
    });
  });
});
