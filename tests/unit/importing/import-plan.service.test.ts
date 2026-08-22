import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImportMutationRequestHash } from "@/importing/utils/import-plan-compiler";

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        importSession: {
            findFirst: vi.fn(),
            update: vi.fn(),
        },
        importPlan: {
            findUnique: vi.fn(),
            create: vi.fn(),
        },
        importRunItem: { findMany: vi.fn() },
        seat: { findMany: vi.fn() },
        shift: { findMany: vi.fn() },
        multiShift: { findMany: vi.fn() },
    };
    return {
        authorize: vi.fn(),
        assertBranchWritable: vi.fn(),
        getMaxPlannedMutations: vi.fn(),
        planFindFirst: vi.fn(),
        tx,
        transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
});

vi.mock("@/services/staff.service", () => ({
    StaffService: { authorize: mocks.authorize },
}));
vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: mocks.assertBranchWritable },
}));
vi.mock("@/lib/importFeature", () => ({
    getImportMaxPlannedMutations: mocks.getMaxPlannedMutations,
}));
vi.mock("@/lib/prisma", () => ({
    prisma: {
        $transaction: mocks.transaction,
        importPlan: { findFirst: mocks.planFindFirst },
    },
}));

describe("ImportPlanService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(true);
        mocks.assertBranchWritable.mockResolvedValue({});
        mocks.getMaxPlannedMutations.mockReturnValue(5000);
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "session_1" }]);
        mocks.tx.importSession.findFirst.mockResolvedValue({
            id: "session_1",
            engineVersion: 2,
            goal: "FULL",
            mapping: { entityTypesDetected: ["STUDENT"], columnMappings: [] },
            summary: null,
            draftRevision: 3,
            activeEvaluationRevision: 3,
            archivedAt: null,
            questions: [],
            rows: [],
        });
        mocks.tx.importSession.update.mockResolvedValue({});
        mocks.tx.importRunItem.findMany.mockResolvedValue([]);
        mocks.tx.seat.findMany.mockResolvedValue([{ label: "A1" }]);
        mocks.tx.shift.findMany.mockResolvedValue([{
            name: "Morning",
            startTime: null,
            endTime: null,
            price: 1200,
            isReserved: false,
        }]);
        mocks.tx.multiShift.findMany.mockResolvedValue([]);
        mocks.tx.importPlan.findUnique.mockResolvedValue({
            id: "plan_1",
            importSessionId: "session_1",
            revision: 3,
            readinessPolicy: "READY_ROWS_ONLY",
            snapshot: {
                requiredPermissions: ["students", "seat_allocation"],
                mutationSummary: { total: 2 },
                configurationApproval: { required: false, approved: false, affectedRows: 0 },
                items: [],
            },
        });
    });

    it("does not reuse a runnable plan after the current mutation cap is lowered", async () => {
        mocks.getMaxPlannedMutations.mockReturnValueOnce(1);
        const { ImportPlanService } = await import("@/importing/services/import-plan.service");

        await expect(ImportPlanService.compilePlan({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            targetRevision: 3,
            readinessPolicy: "READY_ROWS_ONLY",
        })).rejects.toThrow("above the current safety limit");

        expect(mocks.tx.importPlan.create).not.toHaveBeenCalled();
    });

    it("rechecks the current cap when retrieving a reviewed plan for commit", async () => {
        mocks.getMaxPlannedMutations.mockReturnValueOnce(1);
        mocks.planFindFirst.mockResolvedValueOnce({
            id: "plan_1",
            revision: 3,
            planVersion: "plan-version-1",
            canRun: true,
            importSessionId: "session_1",
            snapshot: {
                mutationSummary: { total: 2 },
                requiredPermissions: ["students"],
            },
            session: { draftRevision: 3, activeEvaluationRevision: 3 },
        });
        const { ImportPlanService } = await import("@/importing/services/import-plan.service");

        await expect(ImportPlanService.getPlanForCommit(
            "user_1",
            "branch_1",
            "session_1",
            "plan_1"
        )).rejects.toThrow("above the current safety limit");
    });

    it("rechecks entitlement and every persisted permission before returning an existing plan", async () => {
        const { ImportPlanService } = await import("@/importing/services/import-plan.service");

        const plan = await ImportPlanService.compilePlan({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            targetRevision: 3,
            readinessPolicy: "READY_ROWS_ONLY",
        });

        expect(plan).toMatchObject({ id: "plan_1" });
        expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1", mocks.tx);
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "students", mocks.tx);
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "seat_allocation", mocks.tx);
        expect(mocks.tx.importPlan.create).not.toHaveBeenCalled();
    });

    it("loads retained successes so a repair plan links remaining work to the created student", async () => {
        mocks.tx.importPlan.findUnique.mockResolvedValueOnce(null);
        mocks.tx.importSession.findFirst.mockResolvedValueOnce({
            id: "session_1",
            engineVersion: 2,
            goal: "STUDENTS_ALLOCATIONS",
            mapping: { entityTypesDetected: ["STUDENT", "ALLOCATION"], columnMappings: [] },
            summary: null,
            draftRevision: 3,
            activeEvaluationRevision: 3,
            archivedAt: null,
            questions: [],
            rows: [{
                id: "row_1",
                rowNumber: 2,
                evaluations: [{
                    id: "evaluation_1",
                    importRowId: "row_1",
                    status: "READY",
                    skipped: false,
                    normalizedData: {
                        student: { name: "Asha" },
                        allocation: { seatLabel: "A1", shiftName: "Morning" },
                    },
                    warnings: [],
                }],
            }],
        });
        mocks.tx.importRunItem.findMany.mockResolvedValueOnce([{
            itemKey: "row:row_1:student",
            kind: "STUDENT",
            importRowId: "row_1",
            requestHash: createImportMutationRequestHash({
                itemKey: "row:row_1:student",
                kind: "STUDENT",
                payload: {
                    student: { name: "Asha" },
                    billingStartAt: null,
                },
            }),
            result: { entityIds: ["student_1"] },
        }]);
        mocks.tx.importPlan.create.mockImplementationOnce(async ({ data }) => data);
        const { ImportPlanService } = await import("@/importing/services/import-plan.service");

        const plan = await ImportPlanService.compilePlan({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            targetRevision: 3,
            readinessPolicy: "READY_ROWS_ONLY",
        });

        const snapshot = plan.snapshot as unknown as { items: unknown[] };
        expect(snapshot.items).toEqual([
            expect.objectContaining({
                itemKey: "row:row_1:allocation",
                kind: "ALLOCATION",
                payload: {
                    studentId: "student_1",
                    allocation: { seatLabel: "A1", shiftName: "Morning" },
                },
            }),
        ]);
    });
});
