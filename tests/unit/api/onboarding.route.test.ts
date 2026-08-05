import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  createNetwork: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/onboarding.service", () => ({
  OnboardingService: {
    createNetwork: mocks.createNetwork,
  },
}));

describe("POST /api/onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function request(body: Record<string, unknown>) {
    return new Request("http://test.local/api/onboarding", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("passes custom seat numbering to the service", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "owner@test.com" });
    mocks.createNetwork.mockResolvedValue({ branch: { id: "branch_1" } });
    const { POST } = await import("@/app/api/onboarding/route");

    const seatNumbering = {
      mode: "RANGE",
      ranges: [
        { prefix: "A", start: 1, end: 2, separator: "" },
        { prefix: "B", start: 1, end: 1, separator: "" },
      ],
    };
    const response = await POST(request({
      orgName: "Bright Academy",
      ownerPhone: "9876543210",
      branchName: "Main Hall",
      seatCount: 3,
      seatNumbering,
      selectedPostTrialPlan: "PRO",
    }));

    expect(response.status).toBe(201);
    expect(mocks.createNetwork).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      ownerPhone: "+91 98765 43210",
      seatCount: 3,
      seatNumbering,
      selectedPostTrialPlan: "PRO",
    }));
  });

  it("rejects seat numbering that does not match total seats", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "owner@test.com" });
    const { POST } = await import("@/app/api/onboarding/route");

    const response = await POST(request({
      orgName: "Bright Academy",
      ownerPhone: "9876543210",
      branchName: "Main Hall",
      selectedPostTrialPlan: "BASIC",
      seatCount: 4,
      seatNumbering: {
        mode: "RANGE",
        ranges: [{ prefix: "A", start: 1, end: 3, separator: "" }],
      },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Seat numbering creates 3 labels, but total seats is 4.",
    });
    expect(mocks.createNetwork).not.toHaveBeenCalled();
  });

  it.each([undefined, "AGENT_CONTROL", "CUSTOM", "STANDARD", "PRO<script>"])(
    "rejects an invalid post-trial plan identifier: %s",
    async selectedPostTrialPlan => {
      mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "owner@test.com" });
      const { POST } = await import("@/app/api/onboarding/route");

      const response = await POST(request({
        orgName: "Bright Academy",
        ownerPhone: "9876543210",
        branchName: "Main Hall",
        seatCount: 1,
        seatNumbering: { mode: "SIMPLE" },
        selectedPostTrialPlan,
      }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Choose Basic or Standard as the post-trial plan.",
      });
      expect(mocks.createNetwork).not.toHaveBeenCalled();
    }
  );
});
