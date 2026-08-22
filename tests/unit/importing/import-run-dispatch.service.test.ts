import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        importRun: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
        seat: { findMany: vi.fn() },
        shift: { findMany: vi.fn() },
        multiShift: { findMany: vi.fn() },
    };
    return {
        tx,
        authorize: vi.fn(),
        assertBranchWritable: vi.fn(),
        transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
});

vi.mock("@/services/staff.service", () => ({ StaffService: { authorize: mocks.authorize } }));
vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: mocks.assertBranchWritable },
}));
vi.mock("@/lib/importFeature", () => ({ getImportMaxPlannedMutations: () => 5_000 }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));

const snapshot = {
    schemaVersion: 2,
    sessionId: "session_1",
    targetRevision: 3,
    engineVersion: 2,
    goal: "FULL",
    readinessPolicy: "READY_ROWS_ONLY",
    mapping: { entityTypesDetected: ["STUDENT", "PAYMENT"], columnMappings: [] },
    summary: null,
    evaluations: [],
    items: [],
    requiredPermissions: ["students", "view_payments", "generate_payments"],
    configurationApproval: { required: false, approved: false, affectedRows: 0 },
    mutationSummary: { total: 0 },
};

describe("ImportRunService.getDispatchableRun", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "run_1" }]);
        mocks.tx.seat.findMany.mockResolvedValue([]);
        mocks.tx.shift.findMany.mockResolvedValue([]);
        mocks.tx.multiShift.findMany.mockResolvedValue([]);
        mocks.tx.importRun.findFirst.mockResolvedValue({
            id: "run_1",
            branchId: "branch_1",
            importSessionId: "session_1",
            kind: "COMMIT",
            status: "QUEUED",
            workflowRunId: null,
            session: { id: "session_1", branchId: "branch_1", archivedAt: null },
            plan: { id: "plan_1", importSessionId: "session_1", snapshot },
        });
    });

    it("rechecks the complete commit-start trust boundary before resume dispatch", async () => {
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        await expect(ImportRunService.getDispatchableRun(
            "user_1", "branch_1", "run_1"
        )).resolves.toMatchObject({ id: "run_1", status: "QUEUED" });

        expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1");
        expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1", mocks.tx);
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "view_payments", mocks.tx);
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "generate_payments", mocks.tx);
        expect(mocks.tx.seat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { branchId: "branch_1" } }));
    });

    it("fails closed when a required payment permission was revoked", async () => {
        mocks.authorize.mockImplementation(async (_userId, _branchId, action, tx) => {
            if (tx && action === "view_payments") throw new Error("Unauthorized");
        });
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        await expect(ImportRunService.getDispatchableRun(
            "user_1", "branch_1", "run_1"
        )).rejects.toThrow("Unauthorized");
    });

    it("keeps missing and foreign run identifiers generic", async () => {
        mocks.tx.importRun.findFirst.mockResolvedValue(null);
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        await expect(ImportRunService.getDispatchableRun(
            "user_1", "branch_1", "run_foreign"
        )).rejects.toThrow("Import run not found");
    });
});

describe("ImportRunService.releaseWorkflowRunForRedispatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "run_1" }]);
        mocks.tx.importRun.findUnique.mockResolvedValue({
            id: "run_1",
            status: "RUNNING",
            workflowRunId: "workflow_old",
        });
        mocks.tx.importRun.update.mockResolvedValue({
            id: "run_1",
            status: "RETRYABLE_FAILURE",
            workflowRunId: null,
        });
    });

    it("CAS-fences the terminal provider owner before redispatch", async () => {
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        await expect(ImportRunService.releaseWorkflowRunForRedispatch({
            importRunId: "run_1",
            expectedWorkflowRunId: "workflow_old",
        })).resolves.toMatchObject({ status: "RETRYABLE_FAILURE", workflowRunId: null });

        expect(mocks.tx.importRun.update).toHaveBeenCalledWith({
            where: { id: "run_1" },
            data: expect.objectContaining({
                workflowRunId: null,
                status: "RETRYABLE_FAILURE",
                error: expect.objectContaining({ code: "IMPORT_WORKFLOW_PROVIDER_TERMINATED" }),
            }),
        });
    });

    it("does not clear an attachment that another dispatcher already replaced", async () => {
        mocks.tx.importRun.findUnique.mockResolvedValue({
            id: "run_1",
            status: "RUNNING",
            workflowRunId: "workflow_new",
        });
        const { ImportRunService } = await import("@/importing/services/import-run.service");

        await expect(ImportRunService.releaseWorkflowRunForRedispatch({
            importRunId: "run_1",
            expectedWorkflowRunId: "workflow_old",
        })).resolves.toMatchObject({ workflowRunId: "workflow_new" });
        expect(mocks.tx.importRun.update).not.toHaveBeenCalled();
    });
});
