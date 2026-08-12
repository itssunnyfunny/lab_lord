import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  acceptInvite: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/staffInvite.service", () => ({
  StaffInviteService: {
    acceptInvite: mocks.acceptInvite,
  },
}));

describe("POST /api/invites/[token]/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const request = new Request("http://test.local/api/invites/token_1/accept", {
    method: "POST",
  });
  const context = { params: Promise.resolve({ token: "token_1" }) };

  it("requires an authenticated account", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const { POST } = await import("@/app/api/invites/[token]/accept/route");

    const response = await POST(request, context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.acceptInvite).not.toHaveBeenCalled();
  });

  it("accepts only after the explicit POST and returns through /app", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "staff@example.com" });
    mocks.acceptInvite.mockResolvedValue({ branchId: "branch_1" });
    const { POST } = await import("@/app/api/invites/[token]/accept/route");

    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ branchId: "branch_1", destination: "/app" });
    expect(mocks.acceptInvite).toHaveBeenCalledWith("user_1", "token_1");
  });

  it("rejects a different signed-in email without creating access", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user_2", email: "other@example.com" });
    mocks.acceptInvite.mockRejectedValue(
      new Error("This invite was issued to a different email address.")
    );
    const { POST } = await import("@/app/api/invites/[token]/accept/route");

    const response = await POST(request, context);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This invite was issued to a different email address.",
    });
  });

  it("requires legacy anonymous links to be replaced", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "staff@example.com" });
    mocks.acceptInvite.mockRejectedValue(
      new Error("This invite link is no longer supported. Ask the branch owner for a fresh invite.")
    );
    const { POST } = await import("@/app/api/invites/[token]/accept/route");

    const response = await POST(request, context);

    expect(response.status).toBe(410);
  });
});
