import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    getSessionDetail: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
    getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/importing/services/import-session.service", () => ({
    ImportSessionService: {
        getSessionDetail: mocks.getSessionDetail,
    },
}));

describe("import session issue-filter query", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
    });

    it("forwards a normalized issue code with the server-side page request", async () => {
        mocks.getSessionDetail.mockResolvedValueOnce({ id: "session_1", rows: [] });
        const { GET } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/route");

        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-sessions/session_1?rowFilter=attention&issueCode=%20INVALID_PHONE%20&limit=120"),
            { params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1" }) }
        );

        expect(response.status).toBe(200);
        expect(mocks.getSessionDetail).toHaveBeenCalledWith("user_1", "branch_1", "session_1", {
            rowFilter: "attention",
            issueCode: "INVALID_PHONE",
            limit: 120,
            cursor: undefined,
        });
    });

    it.each(["", "invalid phone", "../../INVALID_PHONE"])("rejects an invalid issue code %j", async issueCode => {
        const { GET } = await import("@/app/api/branches/[branchId]/import-sessions/[sessionId]/route");

        const response = await GET(
            new Request(`http://test.local/api/branches/branch_1/import-sessions/session_1?issueCode=${encodeURIComponent(issueCode)}`),
            { params: Promise.resolve({ branchId: "branch_1", sessionId: "session_1" }) }
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "INVALID_ROW_ISSUE_FILTER" });
        expect(mocks.getSessionDetail).not.toHaveBeenCalled();
    });
});
