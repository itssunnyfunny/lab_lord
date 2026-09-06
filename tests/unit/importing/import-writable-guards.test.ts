import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    assertBranchWritable: vi.fn(),
    transaction: vi.fn(),
    importSessionFindFirst: vi.fn(),
}));

vi.mock("@/services/staff.service", () => ({
    StaffService: {
        authorize: mocks.authorize,
    },
}));

vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: {
        assertBranchWritable: mocks.assertBranchWritable,
    },
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
        $transaction: mocks.transaction,
        importSession: {
            findFirst: mocks.importSessionFindFirst,
        },
    },
}));

describe("import writable guards", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(true);
        mocks.assertBranchWritable.mockRejectedValue(new Error("Branch is read-only"));
    });

    it("rejects session creation before parsing or writing", async () => {
        const { ImportSessionService } = await import("@/importing/services/import-session.service");

        await expect(ImportSessionService.createSession("user_1", "branch_1", {
            sourceType: "PASTED_TABLE",
            pastedTable: "Name\nAsha",
        })).rejects.toThrow("read-only");

        expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1");
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("rejects public revalidation before reading or writing session rows", async () => {
        const { ImportSessionService } = await import("@/importing/services/import-session.service");

        await expect(ImportSessionService.revalidateSession("user_1", "branch_1", "session_1"))
            .rejects.toThrow("read-only");

        expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1");
        expect(mocks.importSessionFindFirst).not.toHaveBeenCalled();
    });

    it("rejects analyze, mapping, and row mutations before session access", async () => {
        const { ImportSessionService } = await import("@/importing/services/import-session.service");
        const mutationCalls = [
            () => ImportSessionService.analyzeSession("user_1", "branch_1", "session_1"),
            () => ImportSessionService.updateMapping("user_1", "branch_1", "session_1", { expectedRevision: 0 }),
            () => ImportSessionService.updateRows("user_1", "branch_1", "session_1", { expectedRevision: 0 }),
        ];

        for (const mutate of mutationCalls) {
            await expect(mutate()).rejects.toThrow("read-only");
        }

        expect(mocks.assertBranchWritable).toHaveBeenCalledTimes(mutationCalls.length);
        expect(mocks.importSessionFindFirst).not.toHaveBeenCalled();
    });
});

vi.mock("@/services/accessPolicy.service", async importOriginal => {
    const actual = await importOriginal<typeof import("@/services/accessPolicy.service")>();
    const { callerPolicyMock } = await import("@/tests/helpers/accessPolicyCallerMock");
    const { StaffService } = await import("@/services/staff.service");
    const { EntitlementService } = await import("@/services/entitlement.service");
    return { ...actual, AccessPolicy: callerPolicyMock(actual.AccessPolicy, StaffService, EntitlementService) };
});
