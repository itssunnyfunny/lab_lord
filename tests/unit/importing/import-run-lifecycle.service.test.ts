import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    tx: {
        $queryRaw: vi.fn(),
        importSession: {
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
        importRunItem: { findMany: vi.fn() },
        importRow: {
            findMany: vi.fn(),
            update: vi.fn(),
        },
    },
}));

describe("import run session lifecycle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "session_1" }]);
        mocks.tx.importSession.findFirst.mockResolvedValue({ status: "COMMITTING" });
        mocks.tx.importSession.updateMany.mockResolvedValue({ count: 1 });
        mocks.tx.importRunItem.findMany.mockResolvedValue([]);
        mocks.tx.importRow.findMany.mockResolvedValue([]);
        mocks.tx.importRow.update.mockResolvedValue({});
    });

    it("projects successful and failed item groups without mutating skipped rows", async () => {
        mocks.tx.importRunItem.findMany.mockResolvedValue([
            { importRowId: "row_1", kind: "STUDENT", status: "SUCCEEDED", result: { entityIds: ["student_1"] } },
            { importRowId: "row_1", kind: "ALLOCATION", status: "SUCCEEDED", result: { entityIds: ["allocation_1"] } },
            { importRowId: "row_1", kind: "PAYMENT_CYCLE", status: "SUCCEEDED", result: { entityIds: ["payment_1"] } },
            { importRowId: "row_1", kind: "PAYMENT_CYCLE", status: "SUCCEEDED", result: { entityIds: ["payment_2"] } },
            { importRowId: "row_2", kind: "STUDENT", status: "SUCCEEDED", result: { entityIds: ["student_2"] } },
            { importRowId: "row_2", kind: "ALLOCATION", status: "FAILED", result: null },
            { importRowId: "row_3", kind: "STUDENT", status: "SKIPPED", result: null },
        ]);
        mocks.tx.importRow.findMany.mockResolvedValue([
            { id: "row_1", createdEntityIds: null },
            { id: "row_2", createdEntityIds: { prior: "kept", paymentIds: ["payment_prior"] } },
            { id: "row_3", createdEntityIds: null },
        ]);
        const { syncImportSessionRunLifecycle } = await import("@/importing/services/import-run-lifecycle.service");
        const now = new Date("2026-08-18T00:00:00.000Z");

        await syncImportSessionRunLifecycle(mocks.tx as never, {
            id: "run_1",
            branchId: "branch_1",
            importSessionId: "session_1",
            kind: "COMMIT",
            status: "COMPLETED_WITH_ISSUES",
        }, now);

        expect(mocks.tx.importRow.update).toHaveBeenCalledTimes(2);
        expect(mocks.tx.importRow.update).toHaveBeenCalledWith({
            where: { id: "row_1" },
            data: {
                status: "IMPORTED",
                createdEntityIds: {
                    studentId: "student_1",
                    allocationIds: ["allocation_1"],
                    paymentIds: ["payment_1", "payment_2"],
                },
            },
        });
        expect(mocks.tx.importRow.update).toHaveBeenCalledWith({
            where: { id: "row_2" },
            data: {
                status: "FAILED",
                createdEntityIds: { prior: "kept", paymentIds: ["payment_prior"], studentId: "student_2" },
            },
        });
        expect(mocks.tx.importSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: {
                status: "PARTIAL",
                purgeAfter: new Date("2026-09-17T00:00:00.000Z"),
            },
        }));
    });

    it("merges entity ids from a repair run with successes retained from prior runs", async () => {
        mocks.tx.importRunItem.findMany.mockResolvedValue([
            { importRowId: "row_1", kind: "PAYMENT_CYCLE", status: "SUCCEEDED", result: { entityIds: ["payment_2"] } },
        ]);
        mocks.tx.importRow.findMany.mockResolvedValue([{
            id: "row_1",
            createdEntityIds: {
                studentId: "student_1",
                allocationIds: ["allocation_1"],
                paymentIds: ["payment_1"],
            },
        }]);
        const { syncImportSessionRunLifecycle } = await import("@/importing/services/import-run-lifecycle.service");

        await syncImportSessionRunLifecycle(mocks.tx as never, {
            id: "run_2",
            branchId: "branch_1",
            importSessionId: "session_1",
            kind: "COMMIT",
            status: "COMPLETED",
        }, new Date("2026-08-18T00:00:00.000Z"));

        expect(mocks.tx.importRow.update).toHaveBeenCalledWith({
            where: { id: "row_1" },
            data: {
                status: "IMPORTED",
                createdEntityIds: {
                    studentId: "student_1",
                    allocationIds: ["allocation_1"],
                    paymentIds: ["payment_1", "payment_2"],
                },
            },
        });
    });

    it("is replay-safe once the session already reflects the terminal run", async () => {
        mocks.tx.importSession.findFirst.mockResolvedValueOnce({ status: "COMMITTED" });
        const { syncImportSessionRunLifecycle } = await import("@/importing/services/import-run-lifecycle.service");

        await syncImportSessionRunLifecycle(mocks.tx as never, {
            id: "run_1",
            branchId: "branch_1",
            importSessionId: "session_1",
            kind: "COMMIT",
            status: "COMPLETED",
        }, new Date("2026-08-18T00:00:00.000Z"));

        expect(mocks.tx.importRunItem.findMany).toHaveBeenCalledTimes(1);
        expect(mocks.tx.importRow.update).not.toHaveBeenCalled();
        expect(mocks.tx.importSession.updateMany).not.toHaveBeenCalled();
    });

    it("projects a second partial repair run even while the session is already partial", async () => {
        mocks.tx.importSession.findFirst.mockResolvedValueOnce({ status: "PARTIAL" });
        mocks.tx.importRunItem.findMany.mockResolvedValueOnce([
            { importRowId: "row_2", kind: "STUDENT", status: "SUCCEEDED", result: { entityIds: ["student_2"] } },
        ]);
        mocks.tx.importRow.findMany.mockResolvedValueOnce([{
            id: "row_2",
            createdEntityIds: null,
        }]);
        const { syncImportSessionRunLifecycle } = await import("@/importing/services/import-run-lifecycle.service");

        await syncImportSessionRunLifecycle(mocks.tx as never, {
            id: "run_2",
            branchId: "branch_1",
            importSessionId: "session_1",
            kind: "COMMIT",
            status: "COMPLETED_WITH_ISSUES",
        }, new Date("2026-08-18T00:00:00.000Z"));

        expect(mocks.tx.importRow.update).toHaveBeenCalledWith({
            where: { id: "row_2" },
            data: {
                status: "IMPORTED",
                createdEntityIds: { studentId: "student_2" },
            },
        });
        expect(mocks.tx.importSession.updateMany).not.toHaveBeenCalled();
    });
});
