import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    getPlanForCommit: vi.fn(),
    createOrGetRun: vi.fn(),
    tryStartRun: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
    getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/importing/services/import-plan.service", () => ({
    ImportPlanService: {
        getPlanForCommit: mocks.getPlanForCommit,
    },
}));

vi.mock("@/importing/services/import-run.service", () => ({
    ImportRunService: {
        createOrGetRun: mocks.createOrGetRun,
    },
}));

vi.mock("@/importing/services/import-workflow", () => ({
    ImportWorkflowService: {
        tryStartRun: mocks.tryStartRun,
    },
}));

function routeContext() {
    return { params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1" }) };
}

function commitRequest(
    body: Record<string, unknown>,
    idempotencyKey?: string,
) {
    return new Request("http://test.local/api/branches/branch_1/import-sessions/session_1/commit", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
    });
}

describe("/api/branches/[branchId]/import-sessions/[sessionId]/commit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("IMPORT_V2_ENABLED", "true");
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
        mocks.getPlanForCommit.mockResolvedValue({
            id: "plan_1",
            planVersion: "plan_hash_1",
            revision: 4,
        });
        mocks.createOrGetRun.mockResolvedValue({
            id: "run_1",
            kind: "COMMIT",
            status: "QUEUED",
            workflowRunId: null,
        });
        mocks.tryStartRun.mockResolvedValue({
            run: { id: "run_1", status: "RUNNING" },
            dispatchPending: false,
            workflowAttached: true,
            dispatchRequired: false,
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("returns 401 before reading confirmation or idempotency input", async () => {
        mocks.getSessionUser.mockResolvedValueOnce(null);
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const response = await POST(commitRequest({}, undefined), routeContext());

        expect(response.status).toBe(401);
        expect(mocks.getPlanForCommit).not.toHaveBeenCalled();
    });

    it("requires explicit final confirmation", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const response = await POST(
            commitRequest({ confirmed: false, planId: "plan_1" }, "idem_1"),
            routeContext()
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Failed to start the import." });
        expect(mocks.getPlanForCommit).not.toHaveBeenCalled();
    });

    it("requires Idempotency-Key before loading the plan", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const response = await POST(
            commitRequest({ confirmed: true, planId: "plan_1" }),
            routeContext()
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Failed to start the import." });
        expect(mocks.getPlanForCommit).not.toHaveBeenCalled();
    });

    it("creates an idempotent run, starts Workflow, and returns 202", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const response = await POST(
            commitRequest({ confirmed: true, planId: " plan_1 " }, " idem_1 "),
            routeContext()
        );

        expect(mocks.getPlanForCommit).toHaveBeenCalledWith(
            "user_1",
            "branch_1",
            "session_1",
            "plan_1"
        );
        expect(mocks.createOrGetRun).toHaveBeenCalledWith({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            kind: "COMMIT",
            importPlanId: "plan_1",
            confirmedPlanVersion: "plan_hash_1",
            targetRevision: 4,
            idempotencyKey: "idem_1",
        });
        expect(mocks.tryStartRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_1" }));
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({
            runId: "run_1",
            status: "RUNNING",
            dispatchPending: false,
            workflowAttached: true,
            dispatchRequired: false,
        });
    });

    it("replays the same idempotent request in one worker to the same run", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const first = await POST(
            commitRequest({ confirmed: true, planId: "plan_1" }, "idem_replay"),
            routeContext()
        );
        const second = await POST(
            commitRequest({ confirmed: true, planId: "plan_1" }, "idem_replay"),
            routeContext()
        );

        expect(first.status).toBe(202);
        expect(second.status).toBe(202);
        await expect(first.json()).resolves.toMatchObject({ runId: "run_1", status: "RUNNING" });
        await expect(second.json()).resolves.toMatchObject({ runId: "run_1", status: "RUNNING" });
        expect(mocks.createOrGetRun).toHaveBeenCalledTimes(2);
        expect(mocks.createOrGetRun.mock.calls[0]?.[0]).toEqual(mocks.createOrGetRun.mock.calls[1]?.[0]);
        expect(mocks.tryStartRun).toHaveBeenCalledTimes(2);
    });

    it("returns the acquired queued run when Workflow dispatch must be resumed", async () => {
        mocks.tryStartRun.mockResolvedValueOnce({
            run: { id: "run_1", status: "QUEUED" },
            dispatchPending: true,
            workflowAttached: false,
            dispatchRequired: true,
        });
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const response = await POST(
            commitRequest({ confirmed: true, planId: "plan_1" }, "idem_pending"),
            routeContext()
        );

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({
            runId: "run_1",
            status: "QUEUED",
            dispatchPending: true,
            workflowAttached: false,
            dispatchRequired: true,
        });
    });

    it("uses the shared 409 contract for a stale reviewed plan", async () => {
        mocks.getPlanForCommit.mockRejectedValueOnce(Object.assign(new Error("stale plan details"), {
            code: "IMPORT_REVISION_CONFLICT",
        }));
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const response = await POST(
            commitRequest({ confirmed: true, planId: "plan_stale" }, "idem_stale"),
            routeContext()
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            error: "This import changed in another tab. Refresh before saving again.",
            code: "IMPORT_REVISION_CONFLICT",
        });
        expect(mocks.createOrGetRun).not.toHaveBeenCalled();
        expect(mocks.tryStartRun).not.toHaveBeenCalled();
    });

    it("uses the shared 409 contract for an idempotency conflict", async () => {
        const conflict = Object.assign(new Error("internal request hash details"), {
            code: "IMPORT_IDEMPOTENCY_CONFLICT",
        });
        mocks.createOrGetRun.mockRejectedValueOnce(conflict);
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const response = await POST(
            commitRequest({ confirmed: true, planId: "plan_1" }, "idem_reused"),
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
        "Import plan not found",
        "Unauthorized: plan belongs to another branch",
    ])("returns the same tenant-safe response for %s", async message => {
        mocks.getPlanForCommit.mockRejectedValueOnce(new Error(message));
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/commit/route");
        const response = await POST(
            commitRequest({ confirmed: true, planId: "plan_foreign" }, "idem_2"),
            routeContext()
        );

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
            error: "Import resource not found.",
            code: "IMPORT_NOT_FOUND",
        });
    });
});
