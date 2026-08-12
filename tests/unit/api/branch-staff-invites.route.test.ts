import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  createInvite: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/staffInvite.service", () => ({
  StaffInviteService: {
    createInvite: mocks.createInvite,
  },
}));

describe("POST /api/branches/[branchId]/staff-invites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1", email: "owner@example.com" });
  });

  function request(body: Record<string, unknown>) {
    return new NextRequest("http://test.local/api/branches/branch_1/staff-invites", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  const context = { params: Promise.resolve({ branchId: "branch_1" }) };

  it("requires the intended account email", async () => {
    const { POST } = await import("@/app/api/branches/[branchId]/staff-invites/route");

    const response = await POST(request({ role: "STAFF" }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invite email is required." });
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it("rejects an invalid intended account email", async () => {
    const { POST } = await import("@/app/api/branches/[branchId]/staff-invites/route");

    const response = await POST(request({ role: "STAFF", email: "not-an-email" }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invite email must be a valid email." });
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it("binds a new invite to the supplied email", async () => {
    mocks.createInvite.mockResolvedValue({
      id: "invite_1",
      role: "STAFF",
      token: "v2.hash.secret",
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
      createdAt: new Date("2026-08-07T00:00:00.000Z"),
    });
    const { POST } = await import("@/app/api/branches/[branchId]/staff-invites/route");

    const response = await POST(
      request({ role: "STAFF", email: "Staff@Example.com", ttlDays: 7 }),
      context
    );

    expect(response.status).toBe(201);
    expect(mocks.createInvite).toHaveBeenCalledWith(
      "owner_1",
      "branch_1",
      "STAFF",
      "Staff@Example.com",
      7
    );
  });
});
