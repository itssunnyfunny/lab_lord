import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    getPaymentDetails: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/importing/services/import-plan.service", () => ({
    ImportPlanService: { getPaymentDetails: mocks.getPaymentDetails },
}));

const context = {
    params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1", planId: "plan_1" }),
};

describe("GET import plan payment details", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("IMPORT_V2_ENABLED", "true");
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
        mocks.getPaymentDetails.mockResolvedValue({
            planId: "plan_1",
            totalCycles: 2,
            cycles: [{ itemKey: "cycle_2" }],
            page: { limit: 1, cursor: "cycle_1", nextCursor: null, hasMore: false, returnedCycles: 1 },
        });
    });

    afterEach(() => vi.unstubAllEnvs());

    it("authenticates and forwards a bounded cursor page", async () => {
        const { GET } = await import(
            "@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/[planId]/payments/route"
        );
        const response = await GET(new Request(
            "http://test.local/api/branches/branch_1/import-sessions/session_1/plans/plan_1/payments?limit=1&cursor=cycle_1"
        ), context);

        expect(response.status).toBe(200);
        expect(mocks.getPaymentDetails).toHaveBeenCalledWith(
            "user_1", "branch_1", "session_1", "plan_1", { cursor: "cycle_1", limit: 1 }
        );
    });

    it("returns 401 without disclosing plan existence", async () => {
        mocks.getSessionUser.mockResolvedValueOnce(null);
        const { GET } = await import(
            "@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/[planId]/payments/route"
        );
        const response = await GET(new Request("http://test.local/payments"), context);

        expect(response.status).toBe(401);
        expect(mocks.getPaymentDetails).not.toHaveBeenCalled();
    });

    it("rejects malformed page sizes before loading a plan", async () => {
        const { GET } = await import(
            "@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/[planId]/payments/route"
        );
        const response = await GET(new Request("http://test.local/payments?limit=1.5"), context);

        expect(response.status).toBe(400);
        expect(mocks.getPaymentDetails).not.toHaveBeenCalled();
    });
});
