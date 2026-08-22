import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    getRunProgress: vi.fn(),
    requestCancel: vi.fn(),
    getPlanForCommit: vi.fn(),
    createOrGetRun: vi.fn(),
    getDispatchableRun: vi.fn(),
    tryStartRun: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
    getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/importing/services/import-run.service", () => ({
    ImportRunService: {
        getRunProgress: mocks.getRunProgress,
        requestCancel: mocks.requestCancel,
        createOrGetRun: mocks.createOrGetRun,
        getDispatchableRun: mocks.getDispatchableRun,
    },
}));

vi.mock("@/importing/services/import-plan.service", () => ({
    ImportPlanService: {
        getPlanForCommit: mocks.getPlanForCommit,
    },
}));

vi.mock("@/importing/services/import-workflow", () => ({
    ImportWorkflowService: {
        tryStartRun: mocks.tryStartRun,
    },
}));

function routeContext() {
    return { params: Promise.resolve({ branchId: "branch_1", runId: "run_1" }) };
}

function retryRequest(
    body: Record<string, unknown>,
    idempotencyKey?: string,
) {
    return new Request("http://test.local/api/branches/branch_1/import-runs/run_1/retry", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
    });
}

describe("V2 import run routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("IMPORT_V2_ENABLED", "true");
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
        mocks.getRunProgress.mockResolvedValue({
            id: "run_1",
            importSessionId: "session_1",
            kind: "COMMIT",
            status: "COMPLETED_WITH_ISSUES",
            totalItems: 5,
            completedItems: 5,
            succeededItems: 4,
            failedItems: 1,
            skippedItems: 0,
            cancelledItems: 0,
        });
        mocks.requestCancel.mockResolvedValue({ id: "run_1", status: "CANCEL_REQUESTED" });
        mocks.getPlanForCommit.mockResolvedValue({
            id: "plan_2",
            planVersion: "plan_hash_2",
            revision: 5,
        });
        mocks.createOrGetRun.mockResolvedValue({
            id: "run_2",
            kind: "COMMIT",
            status: "QUEUED",
            workflowRunId: null,
        });
        mocks.getDispatchableRun.mockResolvedValue({
            id: "run_2",
            kind: "COMMIT",
            status: "QUEUED",
            workflowRunId: null,
        });
        mocks.tryStartRun.mockResolvedValue({
            run: { id: "run_2", status: "RUNNING" },
            dispatchPending: false,
            workflowAttached: true,
            dispatchRequired: false,
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("polls authorized run progress", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/route");
        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_1"),
            routeContext()
        );

        expect(response.status).toBe(200);
        expect(mocks.getRunProgress).toHaveBeenCalledWith("user_1", "branch_1", "run_1");
        await expect(response.json()).resolves.toEqual(expect.objectContaining({
            id: "run_1",
            status: "COMPLETED_WITH_ISSUES",
            failedItems: 1,
        }));
    });

    it("returns 401 for unauthenticated polling", async () => {
        mocks.getSessionUser.mockResolvedValueOnce(null);
        const { GET } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/route");
        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_1"),
            routeContext()
        );

        expect(response.status).toBe(401);
        expect(mocks.getRunProgress).not.toHaveBeenCalled();
    });

    it("resumes an authorized unattached run and returns 202", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/resume/route");
        const response = await POST(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_1/resume", { method: "POST" }),
            routeContext()
        );

        expect(response.status).toBe(202);
        expect(mocks.getDispatchableRun).toHaveBeenCalledWith("user_1", "branch_1", "run_1");
        expect(mocks.tryStartRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_2" }));
    });

    it("keeps foreign and missing runs generic on resume", async () => {
        mocks.getDispatchableRun.mockRejectedValueOnce(new Error("Import run not found"));
        const { POST } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/resume/route");
        const response = await POST(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_foreign/resume", { method: "POST" }),
            routeContext()
        );

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ code: "IMPORT_NOT_FOUND" });
        expect(mocks.tryStartRun).not.toHaveBeenCalled();
    });

    it("requests cancellation and returns 202", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/cancel/route");
        const response = await POST(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_1/cancel", { method: "POST" }),
            routeContext()
        );

        expect(response.status).toBe(202);
        expect(mocks.requestCancel).toHaveBeenCalledWith("user_1", "branch_1", "run_1");
        await expect(response.json()).resolves.toEqual({ runId: "run_1", status: "CANCEL_REQUESTED" });
    });

    it("retries unresolved rows from a newly reviewed plan and returns 202", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/retry/route");
        const response = await POST(
            retryRequest({ confirmed: true, planId: " plan_2 " }, " retry_key_1 "),
            routeContext()
        );

        expect(mocks.getRunProgress).toHaveBeenCalledWith("user_1", "branch_1", "run_1");
        expect(mocks.getPlanForCommit).toHaveBeenCalledWith("user_1", "branch_1", "session_1", "plan_2");
        expect(mocks.createOrGetRun).toHaveBeenCalledWith({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            kind: "COMMIT",
            importPlanId: "plan_2",
            confirmedPlanVersion: "plan_hash_2",
            targetRevision: 5,
            idempotencyKey: "retry_key_1",
        });
        expect(mocks.tryStartRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_2" }));
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({ runId: "run_2", status: "RUNNING" });
    });

    it("accepts a retryable failure after the user reviews a newer plan", async () => {
        mocks.getRunProgress.mockResolvedValueOnce({
            id: "run_1",
            importSessionId: "session_1",
            importPlanId: "plan_1",
            targetRevision: 3,
            status: "RETRYABLE_FAILURE",
        });
        const { POST } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/retry/route");
        const response = await POST(
            retryRequest({ confirmed: true, planId: "plan_2" }, "retry_key_retryable"),
            routeContext()
        );

        expect(response.status).toBe(202);
        expect(mocks.createOrGetRun).toHaveBeenCalledWith(expect.objectContaining({
            importPlanId: "plan_2",
            targetRevision: 5,
            idempotencyKey: "retry_key_retryable",
        }));
    });

    it("rejects retry for a nonterminal run before loading a plan", async () => {
        mocks.getRunProgress.mockResolvedValueOnce({
            id: "run_1",
            importSessionId: "session_1",
            status: "RUNNING",
        });
        const { POST } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/retry/route");
        const response = await POST(
            retryRequest({ confirmed: true, planId: "plan_2" }, "retry_key_2"),
            routeContext()
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Failed to retry unresolved import rows." });
        expect(mocks.getPlanForCommit).not.toHaveBeenCalled();
        expect(mocks.createOrGetRun).not.toHaveBeenCalled();
    });

    it("uses the shared 409 contract for retry idempotency conflicts", async () => {
        mocks.createOrGetRun.mockRejectedValueOnce(Object.assign(new Error("hash mismatch"), {
            code: "IMPORT_IDEMPOTENCY_CONFLICT",
        }));
        const { POST } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/retry/route");
        const response = await POST(
            retryRequest({ confirmed: true, planId: "plan_2" }, "retry_key_reused"),
            routeContext()
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            error: "This idempotency key was already used for a different import request.",
            code: "IMPORT_IDEMPOTENCY_CONFLICT",
        });
        expect(mocks.tryStartRun).not.toHaveBeenCalled();
    });

    it.each([
        "Import run not found",
        "Unauthorized: run belongs to another branch",
    ])("returns the same tenant-safe polling response for %s", async message => {
        mocks.getRunProgress.mockRejectedValueOnce(new Error(message));
        const { GET } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/route");
        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_foreign"),
            routeContext()
        );

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
            error: "Import resource not found.",
            code: "IMPORT_NOT_FOUND",
        });
    });

    it("returns the tenant-safe 404 contract for foreign cancellation", async () => {
        mocks.requestCancel.mockRejectedValueOnce(new Error("Unauthorized: foreign run"));
        const { POST } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/cancel/route");
        const response = await POST(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_foreign/cancel", { method: "POST" }),
            routeContext()
        );

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
            error: "Import resource not found.",
            code: "IMPORT_NOT_FOUND",
        });
    });
});
