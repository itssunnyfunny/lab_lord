import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    getAnalysisStartState: vi.fn(),
    analyzeSession: vi.fn(),
    confirmPdfExtraction: vi.fn(),
    createOrGetRun: vi.fn(),
    setAnalysisStatus: vi.fn(),
    tryStartRun: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/importing/services/import-session.service", () => ({
    ImportSessionService: {
        getAnalysisStartState: mocks.getAnalysisStartState,
        analyzeSession: mocks.analyzeSession,
    },
}));
vi.mock("@/importing/services/import-run.service", () => ({
    ImportRunService: {
        confirmPdfExtraction: mocks.confirmPdfExtraction,
        createOrGetRun: mocks.createOrGetRun,
    },
}));
vi.mock("@/importing/services/import-runner.service", () => ({
    ImportRunRunner: { setAnalysisStatus: mocks.setAnalysisStatus },
}));
vi.mock("@/importing/services/import-workflow", () => ({
    ImportWorkflowService: { tryStartRun: mocks.tryStartRun },
}));

function request(body: Record<string, unknown> = {}) {
    return new Request("http://localhost/import/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

const context = {
    params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1" }),
};

describe("import analyze route engine boundary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("IMPORT_V2_ENABLED", "true");
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
        mocks.getAnalysisStartState.mockResolvedValue({
            engineVersion: 2,
            draftRevision: 3,
            sourceType: "CSV",
            sourceConfiguration: {},
        });
        mocks.createOrGetRun.mockResolvedValue({
            id: "run_1",
            kind: "ANALYSIS",
            status: "QUEUED",
            workflowRunId: null,
        });
        mocks.tryStartRun.mockImplementation(async run => ({
            run,
            dispatchPending: false,
            workflowAttached: true,
            dispatchRequired: false,
        }));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("starts the already-confirmed V2 PDF run on duplicate confirmation", async () => {
        mocks.getAnalysisStartState.mockResolvedValueOnce({
            engineVersion: 2,
            draftRevision: 3,
            sourceType: "PDF",
            sourceConfiguration: { pdfConfirmed: false },
        });
        mocks.createOrGetRun.mockResolvedValueOnce({
            id: "run_pdf",
            kind: "ANALYSIS",
            status: "WAITING_FOR_USER",
            workflowRunId: null,
        });
        mocks.confirmPdfExtraction.mockResolvedValue({
            id: "run_pdf",
            kind: "ANALYSIS",
            status: "QUEUED",
            workflowRunId: null,
        });
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/analyze/route");

        const response = await POST(request({ confirmPdfExtraction: true }), context);

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({ runId: "run_pdf", status: "QUEUED" });
        expect(mocks.tryStartRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_pdf" }));
        expect(mocks.analyzeSession).not.toHaveBeenCalled();
    });

    it("idempotently creates a missing V2 analysis run and dispatches it", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/analyze/route");

        const response = await POST(request(), context);

        expect(response.status).toBe(202);
        expect(mocks.createOrGetRun).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "session_1",
            targetRevision: 3,
            idempotencyKey: "analysis:session_1:3",
        }));
        expect(mocks.analyzeSession).not.toHaveBeenCalled();
        expect(mocks.tryStartRun).toHaveBeenCalled();
    });

    it("returns a usable 202 when provider dispatch remains pending", async () => {
        mocks.tryStartRun.mockResolvedValueOnce({
            run: { id: "run_1", status: "QUEUED" },
            dispatchPending: true,
            workflowAttached: false,
            dispatchRequired: true,
        });
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/analyze/route");

        const response = await POST(request(), context);

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            runId: "run_1",
            status: "QUEUED",
            dispatchPending: true,
            dispatchRequired: true,
        });
    });

    it("keeps direct analysis only for a legacy engine-one session", async () => {
        mocks.getAnalysisStartState.mockResolvedValueOnce({ engineVersion: 1 });
        mocks.analyzeSession.mockResolvedValueOnce({ id: "session_legacy", status: "READY_TO_COMMIT" });
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/analyze/route");

        const response = await POST(request(), context);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ id: "session_legacy" });
        expect(mocks.createOrGetRun).not.toHaveBeenCalled();
        expect(mocks.tryStartRun).not.toHaveBeenCalled();
    });
});
