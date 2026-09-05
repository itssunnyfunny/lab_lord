import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  authorize: vi.fn(),
  assertBranchEntitlement: vi.fn(),
  assertBranchWritable: vi.fn(),
  runBranchAI: vi.fn(),
  draftOverdueMessages: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));
vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: {
    assertBranchEntitlement: mocks.assertBranchEntitlement,
    assertBranchWritable: mocks.assertBranchWritable,
  },
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
    mocks.assertBranchWritable.mockResolvedValue({ canWrite: true });
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

  it("denies the complete AI report before cache or generation when payments are hidden", async () => {
    mocks.assertBranchEntitlement.mockResolvedValue({ entitlements: ["AI_ACCESS"] });
    mocks.authorize.mockImplementation(async (_user, _branch, action) => {
      if (action === "view_payments") throw new Error("Unauthorized");
      return true;
    });
    const { GET } = await import("@/app/api/ai/branch/[branchId]/route");
    const result = await GET(new Request("http://test.local/api/ai/branch/branch_1"),
      { params: Promise.resolve({ branchId: "branch_1" }) });
    expect(result.status).toBe(403);
    expect(mocks.runBranchAI).not.toHaveBeenCalled();
    expect(await result.json()).not.toHaveProperty("snapshot");
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

  it("does not generate a report when billing makes the branch read-only", async () => {
    mocks.assertBranchEntitlement.mockResolvedValue({ entitlements: ["AI_ACCESS"] });
    mocks.assertBranchWritable.mockRejectedValue(new Error("Unauthorized: restore billing to make changes"));

    const { GET } = await import("@/app/api/ai/branch/[branchId]/route");
    const response = await GET(
      new Request("http://test.local/api/ai/branch/branch_1"),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(response.status).toBe(403);
    expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1");
    expect(mocks.runBranchAI).not.toHaveBeenCalled();
  });

  it("allows cached draft reads but blocks regeneration in read-only mode", async () => {
    mocks.assertBranchEntitlement.mockResolvedValue({ entitlements: ["AI_ACCESS"] });
    mocks.assertBranchWritable.mockRejectedValue(new Error("Unauthorized: restore billing to make changes"));
    mocks.draftOverdueMessages.mockResolvedValue({ items: [], meta: {} });

    const route = await import("@/app/api/ai/branch/[branchId]/messages/route");
    const params = { params: Promise.resolve({ branchId: "branch_1" }) };
    const readResponse = await route.GET(
      new Request("http://test.local/api/ai/branch/branch_1/messages") as never,
      params
    );
    const writeResponse = await route.POST(
      new Request("http://test.local/api/ai/branch/branch_1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds: ["student_1"] }),
      }) as never,
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(readResponse.status).toBe(200);
    expect(writeResponse.status).toBe(403);
    expect(mocks.draftOverdueMessages).toHaveBeenCalledTimes(1);
    expect(mocks.authorize.mock.calls.map(call => call[2])).toEqual([
      "analytics",
      "view_payments",
      "analytics",
      "view_payments",
    ]);
  });

  it("blocks both message reads and regeneration when payment visibility is denied", async () => {
    mocks.assertBranchEntitlement.mockResolvedValue({ entitlements: ["AI_ACCESS"] });
    mocks.draftOverdueMessages.mockResolvedValue({ items: [], meta: {} });
    mocks.authorize.mockImplementation(
      async (_userId: string, _branchId: string, action: string) => {
        if (action === "view_payments") {
          throw new Error("Unauthorized: Permission 'view_payments' is disabled for this staff member");
        }
        return true;
      }
    );

    const route = await import("@/app/api/ai/branch/[branchId]/messages/route");
    const readResponse = await route.GET(
      new Request("http://test.local/api/ai/branch/branch_1/messages") as never,
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    const writeResponse = await route.POST(
      new Request("http://test.local/api/ai/branch/branch_1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds: ["student_1"] }),
      }) as never,
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(readResponse.status).toBe(403);
    expect(writeResponse.status).toBe(403);
    expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "view_payments");
    expect(mocks.draftOverdueMessages).not.toHaveBeenCalled();
  });
});
