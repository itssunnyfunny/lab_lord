import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    setAnalysisStatus: vi.fn(),
    finalizeExhaustedCommitRun: vi.fn(),
    sessionFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
        importSession: { findUnique: mocks.sessionFindUnique },
    },
}));

vi.mock("@/importing/services/import-runner.service", () => ({
    ImportRunRunner: {
        setAnalysisStatus: mocks.setAnalysisStatus,
        finalizeExhaustedCommitRun: mocks.finalizeExhaustedCommitRun,
        finalizeRun: vi.fn(),
    },
}));

vi.mock("@/importing/services/import-run-executor.service", () => ({
    ImportRunExecutor: { executeClaimedItem: vi.fn() },
    classifyImportRunError: vi.fn(),
}));

vi.mock("@/importing/services/import-run.service", () => ({
    ImportRunService: { attachWorkflowRun: vi.fn() },
}));

vi.mock("@/importing/services/import-session.service", () => ({
    ImportSessionService: { analyzeSession: vi.fn() },
}));

describe("analysis Workflow retry exhaustion", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.setAnalysisStatus.mockResolvedValue({
            status: "PERMANENT_FAILURE",
            importSessionId: "session_1",
        });
        mocks.sessionFindUnique.mockResolvedValue({ activeEvaluationRevision: 4 });
        mocks.finalizeExhaustedCommitRun.mockResolvedValue({
            status: "COMPLETED_WITH_ISSUES",
            totalItems: 3,
            completedItems: 3,
            succeededItems: 1,
            failedItems: 2,
            skippedItems: 0,
            cancelledItems: 0,
        });
    });

    it("projects exhausted durable retries into the PostgreSQL ledger", async () => {
        const { finalizeExhaustedImportAnalysis } = await import(
            "@/importing/workflows/import-assistance"
        );

        await expect(finalizeExhaustedImportAnalysis("run_1")).resolves.toEqual({
            status: "PERMANENT_FAILURE",
            revision: 4,
        });
        expect(mocks.setAnalysisStatus).toHaveBeenCalledWith({
            importRunId: "run_1",
            status: "PERMANENT_FAILURE",
            error: {
                code: "IMPORT_ANALYSIS_RETRY_EXHAUSTED",
                message: "Import analysis could not complete after bounded retries.",
                retryable: false,
            },
        });
    });

    it("projects exhausted commit retries into the PostgreSQL ledger", async () => {
        const { finalizeExhaustedImportCommit } = await import(
            "@/importing/workflows/import-assistance"
        );

        await expect(finalizeExhaustedImportCommit("run_commit")).resolves.toMatchObject({
            status: "COMPLETED_WITH_ISSUES",
            completedItems: 3,
            failedItems: 2,
        });
        expect(mocks.finalizeExhaustedCommitRun).toHaveBeenCalledWith("run_commit");
    });
});
