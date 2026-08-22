import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    planFindFirst: vi.fn(),
}));

vi.mock("@/services/staff.service", () => ({
    StaffService: { authorize: mocks.authorize },
}));

vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
        importPlan: { findFirst: mocks.planFindFirst },
    },
}));

const snapshot = {
    requiredPermissions: ["students", "view_payments", "generate_payments"],
    mutationSummary: {
        paymentBreakdown: [{
            rowId: "row_1",
            rowNumber: 2,
            studentName: "Asha",
            historical: { DUE: 1, PAID: 0, WAIVED: 0 },
            current: { DUE: 0, PAID: 1, WAIVED: 0 },
            total: 2,
        }],
    },
    items: [
        {
            itemKey: "row:row_1:payment:2026-01-01",
            kind: "PAYMENT_CYCLE",
            rowId: "row_1",
            payload: {
                bucket: "historical",
                status: "DUE",
                amount: 1200,
                cycle: {
                    periodStart: "2026-01-01T00:00:00.000Z",
                    periodEnd: "2026-02-01T00:00:00.000Z",
                    dueDate: "2026-02-01T00:00:00.000Z",
                },
            },
        },
        {
            itemKey: "row:row_1:payment:2026-02-01",
            kind: "PAYMENT_CYCLE",
            rowId: "row_1",
            payload: {
                bucket: "current",
                status: "PAID",
                amount: 1200,
                method: "UPI",
                referenceId: " ref-2 ",
                cycle: {
                    periodStart: "2026-02-01T00:00:00.000Z",
                    periodEnd: "2026-03-01T00:00:00.000Z",
                    dueDate: "2026-03-01T00:00:00.000Z",
                },
            },
        },
    ],
};

describe("ImportPlanService.getPaymentDetails", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.planFindFirst.mockResolvedValue({
            id: "plan_1",
            revision: 4,
            planVersion: "plan_hash",
            snapshot,
        });
    });

    it("returns exact immutable cycles in stable bounded pages", async () => {
        const { ImportPlanService } = await import("@/importing/services/import-plan.service");

        const first = await ImportPlanService.getPaymentDetails(
            "user_1", "branch_1", "session_1", "plan_1", { limit: 1 }
        );
        const second = await ImportPlanService.getPaymentDetails(
            "user_1", "branch_1", "session_1", "plan_1", {
                limit: 1,
                cursor: first.page.nextCursor!,
            }
        );

        expect(first).toMatchObject({
            totalCycles: 2,
            affectedStudents: 1,
            cycles: [{
                studentName: "Asha",
                bucket: "historical",
                amount: 1200,
                status: "DUE",
                periodStart: "2026-01-01T00:00:00.000Z",
            }],
            page: { hasMore: true, returnedCycles: 1 },
        });
        expect(second).toMatchObject({
            cycles: [{
                bucket: "current",
                status: "PAID",
                method: "UPI",
                referenceId: "ref-2",
            }],
            page: { hasMore: false, returnedCycles: 1 },
        });
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "view_payments", undefined);
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "generate_payments", undefined);
    });

    it("fails closed when a required payment permission was revoked", async () => {
        mocks.authorize.mockImplementation(async (_userId, _branchId, action) => {
            if (action === "view_payments") throw new Error("Unauthorized");
        });
        const { ImportPlanService } = await import("@/importing/services/import-plan.service");

        await expect(ImportPlanService.getPaymentDetails(
            "user_1", "branch_1", "session_1", "plan_1"
        )).rejects.toThrow("Unauthorized");
    });

    it("uses the same not-found service result for foreign and missing plans", async () => {
        mocks.planFindFirst.mockResolvedValue(null);
        const { ImportPlanService } = await import("@/importing/services/import-plan.service");

        await expect(ImportPlanService.getPaymentDetails(
            "user_1", "branch_1", "session_1", "plan_foreign"
        )).rejects.toThrow("Import plan not found");
    });
});
