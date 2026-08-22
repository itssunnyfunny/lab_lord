import { beforeEach, describe, expect, it, vi } from "vitest";
import { isImportRunDispatchRequired } from "@/importing/utils/import-run-dispatch";

const mocks = vi.hoisted(() => ({
    start: vi.fn(),
    getRun: vi.fn(),
    attachWorkflowRun: vi.fn(),
    releaseWorkflowRunForRedispatch: vi.fn(),
    getWorkflowDispatchState: vi.fn(),
}));

vi.mock("workflow/api", () => ({ start: mocks.start, getRun: mocks.getRun }));
vi.mock("@/importing/services/import-run.service", () => ({
    ImportRunService: {
        attachWorkflowRun: mocks.attachWorkflowRun,
        releaseWorkflowRunForRedispatch: mocks.releaseWorkflowRunForRedispatch,
        getWorkflowDispatchState: mocks.getWorkflowDispatchState,
    },
}));
vi.mock("@/importing/workflows/import-assistance", () => ({
    executeImportAnalysisWorkflow: vi.fn(),
    executeImportCommitWorkflow: vi.fn(),
}));

const attachedRun = {
    id: "run_1",
    kind: "COMMIT" as const,
    workflowRunId: "workflow_old",
    status: "RUNNING",
};

describe("Import Workflow dispatch recovery", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getRun.mockReturnValue({
            exists: Promise.resolve(true),
            status: Promise.resolve("running"),
        });
        mocks.releaseWorkflowRunForRedispatch.mockResolvedValue({
            ...attachedRun,
            status: "RETRYABLE_FAILURE",
            workflowRunId: null,
        });
        mocks.start.mockResolvedValue({ runId: "workflow_new" });
        mocks.attachWorkflowRun.mockResolvedValue({
            ...attachedRun,
            workflowRunId: "workflow_new",
        });
        mocks.getWorkflowDispatchState.mockResolvedValue(attachedRun);
    });

    it("keeps an attached provider run that is still active", async () => {
        const { ImportWorkflowService } = await import("@/importing/services/import-workflow");

        await expect(ImportWorkflowService.startRun(attachedRun)).resolves.toEqual(attachedRun);
        expect(mocks.releaseWorkflowRunForRedispatch).not.toHaveBeenCalled();
        expect(mocks.start).not.toHaveBeenCalled();
    });

    it.each(["failed", "cancelled", "completed"])(
        "fences and replaces an attached provider run that is %s",
        async providerStatus => {
            mocks.getRun.mockReturnValue({
                exists: Promise.resolve(true),
                status: Promise.resolve(providerStatus),
            });
            const { ImportWorkflowService } = await import("@/importing/services/import-workflow");

            await expect(ImportWorkflowService.startRun(attachedRun)).resolves.toMatchObject({
                workflowRunId: "workflow_new",
            });
            expect(mocks.releaseWorkflowRunForRedispatch).toHaveBeenCalledWith({
                importRunId: "run_1",
                expectedWorkflowRunId: "workflow_old",
            });
            expect(mocks.start).toHaveBeenCalledTimes(1);
            expect(mocks.attachWorkflowRun).toHaveBeenCalledWith({
                importRunId: "run_1",
                workflowRunId: "workflow_new",
            });
        }
    );

    it("replaces an attachment that no longer exists in the provider", async () => {
        mocks.getRun.mockReturnValue({
            exists: Promise.resolve(false),
            status: Promise.resolve("failed"),
        });
        const { ImportWorkflowService } = await import("@/importing/services/import-workflow");

        await ImportWorkflowService.startRun(attachedRun);

        expect(mocks.releaseWorkflowRunForRedispatch).toHaveBeenCalledTimes(1);
        expect(mocks.start).toHaveBeenCalledTimes(1);
    });

    it("keeps provider lookup failures retryable without losing the ledger attachment", async () => {
        mocks.getRun.mockReturnValue({
            exists: Promise.reject(new Error("provider unavailable")),
        });
        const { ImportWorkflowService } = await import("@/importing/services/import-workflow");

        await expect(ImportWorkflowService.tryStartRun(attachedRun)).resolves.toMatchObject({
            dispatchPending: true,
            workflowAttached: true,
            dispatchRequired: true,
        });
        expect(mocks.releaseWorkflowRunForRedispatch).not.toHaveBeenCalled();
    });
});
describe("isImportRunDispatchRequired", () => {
    const now = Date.parse("2026-08-18T12:00:00.000Z");

    it("dispatches unattached queued runs immediately", () => {
        expect(isImportRunDispatchRequired({
            status: "QUEUED",
            workflowRunId: null,
            createdAt: new Date(now),
        }, now)).toBe(true);
    });

    it("reconciles an attached run only after ledger progress is stale", () => {
        expect(isImportRunDispatchRequired({
            status: "RUNNING",
            workflowRunId: "workflow_1",
            lastHeartbeatAt: new Date(now - 60_001),
        }, now)).toBe(true);
        expect(isImportRunDispatchRequired({
            status: "RUNNING",
            workflowRunId: "workflow_1",
            lastHeartbeatAt: new Date(now - 30_000),
        }, now)).toBe(false);
    });

    it("reconciles attached retryable failures immediately", () => {
        expect(isImportRunDispatchRequired({
            status: "RETRYABLE_FAILURE",
            workflowRunId: "workflow_1",
        }, now)).toBe(true);
    });
});
