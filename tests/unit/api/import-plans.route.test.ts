import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    getSessionDetail: vi.fn(),
    compilePlan: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
    getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/importing/services/import-session.service", () => ({
    ImportSessionService: {
        getSessionDetail: mocks.getSessionDetail,
    },
}));

vi.mock("@/importing/services/import-plan.service", () => ({
    ImportPlanService: {
        compilePlan: mocks.compilePlan,
    },
}));

function routeContext() {
    return { params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1" }) };
}

function planRequest(body: Record<string, unknown>) {
    return new Request("http://test.local/api/branches/branch_1/import-sessions/session_1/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("/api/branches/[branchId]/import-sessions/[sessionId]/plans", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("IMPORT_V2_ENABLED", "true");
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
        mocks.getSessionDetail.mockResolvedValue({ id: "session_1", draftRevision: 3 });
        mocks.compilePlan.mockResolvedValue({
            id: "plan_1",
            revision: 3,
            readinessPolicy: "READY_ROWS_ONLY",
            planVersion: "plan_hash_1",
            canRun: true,
            totalRows: 2,
            readyRows: 2,
            blockedRows: 0,
            warningRows: 0,
            skippedRows: 0,
            checks: [{ code: "MUTATION_LIMIT", status: "pass", count: 4 }],
            summary: { totalRows: 2 },
            snapshot: {
                mutationSummary: {
                    total: 4,
                    students: 2,
                    allocations: 2,
                    paymentCycles: 2,
                    affectedRows: { payments: 1 },
                },
                requiredPermissions: ["students", "seat_allocation"],
                configurationApproval: { required: false, approved: false, affectedRows: 0 },
                items: [{ payload: { student: { name: "must-not-leak" } } }],
            },
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("returns 401 before resolving the session", async () => {
        mocks.getSessionUser.mockResolvedValueOnce(null);
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/route");
        const response = await POST(planRequest({}), routeContext());

        expect(response.status).toBe(401);
        expect(mocks.getSessionDetail).not.toHaveBeenCalled();
    });

    it("compiles the current revision with the default policy and omits item payloads", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/route");
        const response = await POST(planRequest({}), routeContext());
        const body = await response.json();

        expect(mocks.getSessionDetail).toHaveBeenCalledWith(
            "user_1",
            "branch_1",
            "session_1",
            { limit: 1 }
        );
        expect(mocks.compilePlan).toHaveBeenCalledWith({
            userId: "user_1",
            branchId: "branch_1",
            sessionId: "session_1",
            targetRevision: 3,
            readinessPolicy: "READY_ROWS_ONLY",
        });
        expect(response.status).toBe(201);
        expect(body).toEqual(expect.objectContaining({
            id: "plan_1",
            revision: 3,
            planVersion: "plan_hash_1",
            canRun: true,
            mutationSummary: {
                total: 4,
                students: 2,
                allocations: 2,
                paymentCycles: 2,
                affectedRows: { payments: 1 },
            },
            paymentDetails: { totalCycles: 2, affectedStudents: 1, maxPageSize: 100 },
            requiredPermissions: ["students", "seat_allocation"],
        }));
        expect(body).not.toHaveProperty("snapshot");
        expect(JSON.stringify(body)).not.toContain("must-not-leak");
    });

    it("uses the shared 409 contract when the requested revision is stale", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/route");
        const response = await POST(planRequest({ targetRevision: 2 }), routeContext());

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            error: "This import changed in another tab. Refresh before saving again.",
            code: "IMPORT_REVISION_CONFLICT",
        });
        expect(mocks.compilePlan).not.toHaveBeenCalled();
    });

    it.each(["3", "", null, 3.5, -1])(
        "rejects non-integer JSON target revision %j instead of coercing it",
        async targetRevision => {
            const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/route");
            const response = await POST(planRequest({ targetRevision }), routeContext());

            expect(response.status).toBe(400);
            expect(mocks.compilePlan).not.toHaveBeenCalled();
        }
    );

    it("rejects an invalid readiness policy without compiling a plan", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/route");
        const response = await POST(planRequest({ readinessPolicy: "ROLL_BACK_EVERYTHING" }), routeContext());

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Failed to build the reviewed import plan." });
        expect(mocks.getSessionDetail).not.toHaveBeenCalled();
        expect(mocks.compilePlan).not.toHaveBeenCalled();
    });

    it.each([
        "Import session not found",
        "Unauthorized: session belongs to another organization",
    ])("returns the same tenant-safe response for %s", async message => {
        mocks.getSessionDetail.mockRejectedValueOnce(new Error(message));
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/plans/route");
        const response = await POST(planRequest({}), routeContext());

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
            error: "Import resource not found.",
            code: "IMPORT_NOT_FOUND",
        });
    });
});
