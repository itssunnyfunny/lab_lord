import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        importSession: { findFirst: vi.fn(), update: vi.fn() },
        importRow: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    };
    return {
        authorize: vi.fn(),
        assertBranchWritable: vi.fn(),
        tx,
        transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
});

vi.mock("@/services/staff.service", () => ({
    StaffService: { authorize: mocks.authorize },
}));
vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: mocks.assertBranchWritable },
}));
vi.mock("@/lib/prisma", () => ({
    prisma: { $transaction: mocks.transaction },
}));

describe("all-affected import row actions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(true);
        mocks.assertBranchWritable.mockResolvedValue({});
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "session_1" }]);
        mocks.tx.importSession.findFirst.mockResolvedValue({
            engineVersion: 2,
            status: "VALIDATED",
            draftRevision: 7,
            archivedAt: null,
        });
        mocks.tx.importSession.update.mockResolvedValue({});
        mocks.tx.importRow.updateMany.mockResolvedValue({ count: 2 });
    });

    it("resolves every unresolved matching issue under the session lock and bumps once", async () => {
        mocks.tx.importRow.findMany
            .mockResolvedValueOnce([
                { id: "row_1", status: "BLOCKED", skipped: false, issues: [{ code: "INVALID_PHONE" }], warnings: [] },
                { id: "row_2", status: "WARNING", skipped: false, issues: [], warnings: [{ code: "INVALID_PHONE" }] },
                { id: "row_3", status: "BLOCKED", skipped: false, issues: [{ code: "OTHER" }], warnings: [] },
            ])
            .mockResolvedValueOnce([
                { id: "row_1", status: "BLOCKED", mappedData: {} },
                { id: "row_2", status: "WARNING", mappedData: {} },
            ]);
        const { ImportSessionService } = await import("@/importing/services/import-session.service");
        const internals = ImportSessionService as unknown as {
            revalidateAuthorizedSession: (
                userId: string,
                branchId: string,
                sessionId: string
            ) => Promise<{ id: string; draftRevision: number }>;
        };
        vi.spyOn(internals, "revalidateAuthorizedSession").mockResolvedValue({
            id: "session_1",
            draftRevision: 8,
        });

        const detail = await ImportSessionService.updateRows("user_1", "branch_1", "session_1", {
            expectedRevision: 7,
            bulkAction: { action: "SKIP", issueCode: "INVALID_PHONE" },
        });

        expect(detail).toMatchObject({ draftRevision: 8 });
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "students", mocks.tx);
        expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1", mocks.tx);
        expect(mocks.tx.importRow.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["row_1", "row_2"] }, importSessionId: "session_1" },
            data: { skipped: true, status: "SKIPPED" },
        });
        expect(mocks.tx.importSession.update).toHaveBeenCalledWith({
            where: { id: "session_1" },
            data: expect.objectContaining({ draftRevision: { increment: 1 } }),
        });
    });

    it("fails the CAS before resolving matching rows", async () => {
        mocks.tx.importSession.findFirst.mockResolvedValueOnce({
            engineVersion: 2,
            status: "VALIDATED",
            draftRevision: 8,
            archivedAt: null,
        });
        const { ImportSessionService } = await import("@/importing/services/import-session.service");

        await expect(ImportSessionService.updateRows("user_1", "branch_1", "session_1", {
            expectedRevision: 7,
            bulkAction: { action: "SKIP", issueCode: "INVALID_PHONE" },
        })).rejects.toMatchObject({ code: "IMPORT_REVISION_CONFLICT" });

        expect(mocks.tx.importRow.findMany).not.toHaveBeenCalled();
        expect(mocks.tx.importRow.updateMany).not.toHaveBeenCalled();
    });
});

vi.mock("@/services/accessPolicy.service", async importOriginal => {
    const actual = await importOriginal<typeof import("@/services/accessPolicy.service")>();
    const { callerPolicyMock } = await import("@/tests/helpers/accessPolicyCallerMock");
    const { StaffService } = await import("@/services/staff.service");
    const { EntitlementService } = await import("@/services/entitlement.service");
    return { ...actual, AccessPolicy: callerPolicyMock(actual.AccessPolicy, StaffService, EntitlementService) };
});
