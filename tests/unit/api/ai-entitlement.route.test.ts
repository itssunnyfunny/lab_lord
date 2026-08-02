import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  authorize: vi.fn(),
  assertBranchEntitlement: vi.fn(),
  runBranchAI: vi.fn(),
  draftOverdueMessages: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));
vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: { assertBranchEntitlement: mocks.assertBranchEntitlement },
}));
vi.mock("@/ai/orchestrator/branchAI.orchestrator", () => ({
  runBranchAI: mocks.runBranchAI,
}));
vi.mock("@/ai/messageDrafting/branchMessageDrafter", () => ({
  draftOverdueMessages: mocks.draftOverdueMessages,
}));

describe("AI route subscription entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "owner@example.com" });
    mocks.authorize.mockResolvedValue(true);
    mocks.assertBranchEntitlement.mockRejectedValue(
      new Error("Unauthorized: ai access requires an upgraded subscription plan")
    );
  });

  it("returns 403 before generating a Basic-plan AI report", async () => {
    const { GET } = await import("@/app/api/ai/branch/[branchId]/route");
    const response = await GET(
      new Request("http://test.local/api/ai/branch/branch_1"),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(response.status).toBe(403);
    expect(mocks.assertBranchEntitlement).toHaveBeenCalledWith("branch_1", "AI_ACCESS");
    expect(mocks.runBranchAI).not.toHaveBeenCalled();
  });

  it("returns 403 before reading Basic-plan AI message drafts", async () => {
    const { GET } = await import("@/app/api/ai/branch/[branchId]/messages/route");
    const response = await GET(
      new Request("http://test.local/api/ai/branch/branch_1/messages") as never,
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(response.status).toBe(403);
    expect(mocks.assertBranchEntitlement).toHaveBeenCalledWith("branch_1", "AI_ACCESS");
    expect(mocks.draftOverdueMessages).not.toHaveBeenCalled();
  });
});
