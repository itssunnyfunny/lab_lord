import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        importSession: { findFirst: vi.fn(), update: vi.fn() },
        importPlan: { findFirst: vi.fn() },
        importRun: {
            findUnique: vi.fn(),
            findFirst: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
        },
        importRunItem: {
            createMany: vi.fn(),
            updateMany: vi.fn(),
        },
        seat: { findMany: vi.fn() },
        shift: { findMany: vi.fn() },
        multiShift: { findMany: vi.fn() },
    };
    return {
        authorize: vi.fn(),
        assertBranchWritable: vi.fn(),
        getMaxPlannedMutations: vi.fn(),
        tx,
        transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
        importRunFindUnique: vi.fn(),
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
        importRun: { findUnique: mocks.importRunFindUnique },
    },
}));

const snapshot = {
    schemaVersion: 2,
    sessionId: "session_1",
    targetRevision: 3,
    engineVersion: 2,
    goal: "STUDENTS_ALLOCATIONS",
    readinessPolicy: "READY_ROWS_ONLY",
    mapping: { entityTypesDetected: ["STUDENT"], columnMappings: [] },
    summary: null,
    evaluations: [],
    requiredPermissions: ["students", "seat_allocation"],
    configurationApproval: { required: false, approved: false, affectedRows: 0 },
    mutationSummary: {
        total: 2,
        configuration: 0,
        students: 1,
        allocations: 1,
        paymentCycles: 0,
        affectedRows: { students: 1, allocations: 1, payments: 0, configuration: 0 },
        payments: {
            historical: { DUE: 0, PAID: 0, WAIVED: 0 },
            current: { DUE: 0, PAID: 0, WAIVED: 0 },
        },
    },
    items: [
        {
            itemKey: "row:row_1:student",
            kind: "STUDENT",
            rowId: "row_1",
            evaluationId: "evaluation_1",
            payload: { student: { name: "Asha" } },
        },
        {
            itemKey: "row:row_1:allocation",
            kind: "ALLOCATION",
            rowId: "row_1",
            evaluationId: "evaluation_1",
            payload: { studentItemKey: "row:row_1:student" },
        },
    ],
};

describe("ImportRunService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(true);
        mocks.assertBranchWritable.mockResolvedValue({});
        mocks.getMaxPlannedMutations.mockReturnValue(5000);
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "session_1" }]);
        mocks.tx.importSession.findFirst.mockResolvedValue({
            id: "session_1",
            branchId: "branch_1",
            engineVersion: 2,
            goal: "STUDENTS_ALLOCATIONS",
            draftRevision: 3,
            activeEvaluationRevision: 3,
            archivedAt: null,
        });
        mocks.tx.importSession.update.mockResolvedValue({});
        mocks.tx.importRun.findUnique.mockResolvedValue(null);
        mocks.tx.importRun.findFirst.mockResolvedValue(null);
        mocks.tx.importPlan.findFirst.mockResolvedValue({
            id: "plan_1",
            importSessionId: "session_1",
            revision: 3,
            planVersion: "plan-version-1",
            canRun: true,
            snapshot,
        });
        mocks.tx.importRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "run_1",
            ...data,
        }));
        mocks.tx.importRunItem.createMany.mockResolvedValue({ count: 2 });
        mocks.tx.seat.findMany.mockResolvedValue([]);
        mocks.tx.shift.findMany.mockResolvedValue([]);
        mocks.tx.multiShift.findMany.mockResolvedValue([]);
    });

    it("creates a commit run and one item per immutable plan mutation", async () => {
        const { ImportRunService } = await import("@/importing/services/import-run.service");
        const run = await ImportRunService.createOrGetRun({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            kind: "COMMIT",
            importPlanId: "plan_1",
            confirmedPlanVersion: "plan-version-1",
            targetRevision: 3,
            idempotencyKey: "request-1",
        });

        expect(run).toMatchObject({ id: "run_1", kind: "COMMIT", totalItems: 2 });
        expect(mocks.tx.importRun.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                importSessionId: "session_1",
                importPlanId: "plan_1",
                targetRevision: 3,
                idempotencyKey: "request-1",
                requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
        }));
        const items = mocks.tx.importRunItem.createMany.mock.calls[0][0].data;
        expect(items).toHaveLength(2);
        expect(items.map((item: { itemKey: string }) => item.itemKey)).toEqual([
            "row:row_1:student",
            "row:row_1:allocation",
        ]);
    });

    it("rejects reuse of an idempotency key with a different request hash", async () => {
        mocks.tx.importRun.findUnique.mockResolvedValueOnce({
            id: "run_other",
            idempotencyKey: "request-1",
            requestHash: "different",
        });
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        await expect(ImportRunService.createOrGetRun({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            kind: "COMMIT",
            importPlanId: "plan_1",
            confirmedPlanVersion: "plan-version-1",
            targetRevision: 3,
            idempotencyKey: "request-1",
        })).rejects.toMatchObject({ code: "IMPORT_IDEMPOTENCY_CONFLICT" });
        expect(mocks.tx.importRun.create).not.toHaveBeenCalled();
    });

    it("blocks commit start when the reviewed plan now exceeds the current mutation cap", async () => {
        mocks.getMaxPlannedMutations.mockReturnValueOnce(1);
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        await expect(ImportRunService.createOrGetRun({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            kind: "COMMIT",
            importPlanId: "plan_1",
            confirmedPlanVersion: "plan-version-1",
            targetRevision: 3,
            idempotencyKey: "request-over-cap",
        })).rejects.toThrow("above the current safety limit");

        expect(mocks.tx.importRun.create).not.toHaveBeenCalled();
    });

    it("supersedes a retryable commit when a newer reviewed revision starts", async () => {
        const repairedSnapshot = { ...snapshot, targetRevision: 4 };
        mocks.tx.importSession.findFirst.mockResolvedValueOnce({
            id: "session_1",
            branchId: "branch_1",
            engineVersion: 2,
            goal: "STUDENTS_ALLOCATIONS",
            draftRevision: 4,
            activeEvaluationRevision: 4,
            archivedAt: null,
        });
        mocks.tx.importPlan.findFirst.mockResolvedValueOnce({
            id: "plan_2",
            importSessionId: "session_1",
            revision: 4,
            planVersion: "plan-version-2",
            canRun: true,
            snapshot: repairedSnapshot,
        });
        mocks.tx.importRun.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "run_retryable",
                importSessionId: "session_1",
                kind: "COMMIT",
                status: "RETRYABLE_FAILURE",
                targetRevision: 3,
                requestHash: "old-request",
            });
        mocks.tx.importRunItem.updateMany.mockResolvedValueOnce({ count: 1 });
        mocks.tx.importRun.update.mockResolvedValueOnce({ id: "run_retryable", status: "SUPERSEDED" });
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        const run = await ImportRunService.createOrGetRun({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            kind: "COMMIT",
            importPlanId: "plan_2",
            confirmedPlanVersion: "plan-version-2",
            targetRevision: 4,
            idempotencyKey: "retry-request-2",
        });

        expect(mocks.tx.importRunItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ importRunId: "run_retryable" }),
        }));
        expect(mocks.tx.importRun.update).toHaveBeenCalledWith({
            where: { id: "run_retryable" },
            data: { status: "SUPERSEDED", finishedAt: expect.any(Date) },
        });
        expect(run).toMatchObject({ kind: "COMMIT", targetRevision: 4 });
    });

    it("confirms PDF extraction once and returns the already-confirmed run on replay", async () => {
        mocks.tx.importSession.findFirst.mockResolvedValue({
            id: "session_1",
            sourceConfiguration: { parser: "pdf" },
            archivedAt: null,
        });
        const waitingRun = {
            id: "run_pdf",
            branchId: "branch_1",
            importSessionId: "session_1",
            kind: "ANALYSIS",
            status: "WAITING_FOR_USER",
            workflowRunId: null,
        };
        const queuedRun = { ...waitingRun, status: "QUEUED" };
        mocks.tx.importRun.findFirst
            .mockResolvedValueOnce(waitingRun)
            .mockResolvedValueOnce(queuedRun);
        mocks.tx.importRun.update.mockResolvedValueOnce(queuedRun);
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        const first = await ImportRunService.confirmPdfExtraction("user_1", "branch_1", "session_1");
        const replay = await ImportRunService.confirmPdfExtraction("user_1", "branch_1", "session_1");

        expect(first).toMatchObject({ id: "run_pdf", status: "QUEUED" });
        expect(replay).toMatchObject({ id: "run_pdf", status: "QUEUED" });
        expect(mocks.tx.importSession.update).toHaveBeenCalledTimes(1);
        expect(mocks.tx.importRun.update).toHaveBeenCalledTimes(1);
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "students", mocks.tx);
        expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1", mocks.tx);
    });
});
