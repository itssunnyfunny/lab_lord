import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    updateMapping: vi.fn(),
    updateRows: vi.fn(),
    answerQuestion: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/importing/services/import-session.service", () => ({
    ImportSessionService: {
        updateMapping: mocks.updateMapping,
        updateRows: mocks.updateRows,
    },
}));
vi.mock("@/importing/services/import-question.service", () => ({
    ImportQuestionService: { answerQuestion: mocks.answerQuestion },
}));

type RevisionRoute = "mapping" | "rows" | "questions";

async function invoke(route: RevisionRoute, expectedRevision: unknown) {
    const body = route === "questions"
        ? { expectedRevision, questionId: "question_1", answer: "choice" }
        : { expectedRevision };
    const request = new Request(`http://localhost/import/${route}`, {
        method: route === "questions" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const context = {
        params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1" }),
    };
    if (route === "mapping") {
        const { PATCH } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/mapping/route");
        return PATCH(request, context);
    }
    if (route === "rows") {
        const { PATCH } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/rows/route");
        return PATCH(request, context);
    }
    const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/questions/route");
    return POST(request, context);
}

describe("revisioned import mutation routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
        mocks.updateMapping.mockResolvedValue({ id: "session_1", draftRevision: 1 });
        mocks.updateRows.mockResolvedValue({ id: "session_1", draftRevision: 1 });
        mocks.answerQuestion.mockResolvedValue({ id: "session_1", draftRevision: 1 });
    });

    it.each([
        ["mapping", null],
        ["mapping", ""],
        ["mapping", "0"],
        ["rows", null],
        ["rows", ""],
        ["rows", "0"],
        ["questions", null],
        ["questions", ""],
        ["questions", "0"],
    ] as const)("rejects invalid %s expectedRevision %#", async (route, expectedRevision) => {
        const response = await invoke(route, expectedRevision);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body).toMatchObject({ code: "INVALID_IMPORT_REVISION" });
        expect(mocks.updateMapping).not.toHaveBeenCalled();
        expect(mocks.updateRows).not.toHaveBeenCalled();
        expect(mocks.answerQuestion).not.toHaveBeenCalled();
    });

    it("accepts revision zero as a number", async () => {
        const response = await invoke("mapping", 0);

        expect(response.status).toBe(200);
        expect(mocks.updateMapping).toHaveBeenCalledWith(
            "user_1",
            "branch_1",
            "session_1",
            expect.objectContaining({ expectedRevision: 0 })
        );
    });

    it("forwards a validated all-affected bulk row selector", async () => {
        const request = new Request("http://localhost/import/rows", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                expectedRevision: 0,
                bulkAction: { action: "SKIP", issueCode: "INVALID_PHONE" },
            }),
        });
        const { PATCH } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/rows/route");

        const response = await PATCH(request, {
            params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1" }),
        });

        expect(response.status).toBe(200);
        expect(mocks.updateRows).toHaveBeenCalledWith("user_1", "branch_1", "session_1", {
            expectedRevision: 0,
            edits: undefined,
            skipRowIds: undefined,
            unskipRowIds: undefined,
            bulkAction: { action: "SKIP", issueCode: "INVALID_PHONE" },
        });
    });

    it.each([
        null,
        { action: "DELETE", issueCode: "INVALID_PHONE" },
        { action: "SKIP", issueCode: "" },
        { action: "SKIP", issueCode: "invalid phone" },
    ])("rejects an invalid bulk row action %#", async bulkAction => {
        const request = new Request("http://localhost/import/rows", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedRevision: 0, bulkAction }),
        });
        const { PATCH } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/rows/route");

        const response = await PATCH(request, {
            params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1" }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "INVALID_BULK_ROW_ACTION" });
        expect(mocks.updateRows).not.toHaveBeenCalled();
    });

    it("uses 409 only when the service reports a genuine stale revision", async () => {
        mocks.updateMapping.mockRejectedValueOnce(Object.assign(new Error("Import revision changed"), {
            code: "IMPORT_REVISION_CONFLICT",
        }));

        const response = await invoke("mapping", 0);
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body).toMatchObject({ code: "IMPORT_REVISION_CONFLICT" });
    });
});
