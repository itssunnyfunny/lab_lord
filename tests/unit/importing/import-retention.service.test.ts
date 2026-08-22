import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    sessionFindMany: vi.fn(),
    sessionDeleteMany: vi.fn(),
    runFindMany: vi.fn(),
    runUpdate: vi.fn(),
    runItemUpdateMany: vi.fn(),
    runItemGroupBy: vi.fn(),
    queryRaw: vi.fn(),
    transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
        importSession: { findMany: mocks.sessionFindMany },
        $transaction: mocks.transaction,
    },
}));

import {
    ACTIVE_IMPORT_RUN_STATUSES,
    ImportRetentionService,
} from "@/importing/services/import-retention.service";

function mockLockedBatch(sessionIds: string[], runIds: string[] = []) {
    mocks.queryRaw
        .mockResolvedValueOnce(sessionIds.map(id => ({ id })))
        .mockResolvedValueOnce(runIds.map(id => ({ id })));
}

describe("ImportRetentionService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runFindMany.mockResolvedValue([]);
        mocks.runItemUpdateMany.mockResolvedValue({ count: 0 });
        mocks.runItemGroupBy.mockResolvedValue([]);
        mocks.runUpdate.mockResolvedValue({});
        mocks.sessionDeleteMany.mockResolvedValue({ count: 0 });
        mocks.transaction.mockImplementation((callback: (transaction: unknown) => unknown) => callback({
            $queryRaw: mocks.queryRaw,
            importSession: { deleteMany: mocks.sessionDeleteMany },
            importRun: {
                findMany: mocks.runFindMany,
                update: mocks.runUpdate,
            },
            importRunItem: {
                updateMany: mocks.runItemUpdateMany,
                groupBy: mocks.runItemGroupBy,
            },
        }));
    });

    it("caps each purge, locks expired staging, scrubs execution data, and reports remaining work", async () => {
        const candidates = Array.from({ length: 101 }, (_, index) => ({ id: `session_${index + 1}` }));
        const eligibleIds = candidates.slice(0, 100).map(candidate => candidate.id);
        mocks.sessionFindMany.mockResolvedValue(candidates);
        mockLockedBatch(eligibleIds);
        mocks.runItemUpdateMany.mockResolvedValue({ count: 240 });
        mocks.sessionDeleteMany.mockResolvedValue({ count: 100 });
        const now = new Date("2026-08-18T12:00:00.000Z");

        const result = await ImportRetentionService.purgeExpiredStaging({ now, limit: 500 });

        expect(mocks.sessionFindMany).toHaveBeenCalledWith({
            where: { purgeAfter: { lte: now } },
            orderBy: [{ purgeAfter: "asc" }, { id: "asc" }],
            take: 101,
            select: { id: true },
        });
        expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
        expect(mocks.runFindMany).toHaveBeenCalledWith({
            where: {
                importSessionId: { in: eligibleIds },
                status: { in: ACTIVE_IMPORT_RUN_STATUSES },
            },
            orderBy: { id: "asc" },
            select: { id: true, totalItems: true },
        });
        expect(mocks.runItemUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { run: { importSessionId: { in: eligibleIds } } },
            data: expect.objectContaining({ payload: expect.anything(), error: expect.anything() }),
        }));
        expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: eligibleIds },
                purgeAfter: { lte: now },
            },
        });
        expect(result).toEqual({
            selectedCount: 100,
            scrubbedRunItemCount: 240,
            purgedSessionCount: 100,
            hasMore: true,
        });
    });

    it("purges an abandoned PDF after terminalizing its WAITING_FOR_USER analysis run", async () => {
        const now = new Date("2026-09-18T12:00:00.000Z");
        mocks.sessionFindMany.mockResolvedValue([{ id: "session_pdf" }]);
        mockLockedBatch(["session_pdf"], ["run_pdf"]);
        mocks.runFindMany.mockResolvedValue([{ id: "run_pdf", totalItems: 0 }]);
        mocks.runItemUpdateMany
            .mockResolvedValueOnce({ count: 0 })
            .mockResolvedValueOnce({ count: 0 });
        mocks.sessionDeleteMany.mockResolvedValue({ count: 1 });

        const result = await ImportRetentionService.purgeExpiredStaging({ now });

        expect(mocks.runItemUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: {
                importRunId: { in: ["run_pdf"] },
                status: { in: ["QUEUED", "RUNNING"] },
            },
        }));
        expect(mocks.runUpdate).toHaveBeenCalledWith({
            where: { id: "run_pdf" },
            data: expect.objectContaining({
                status: "CANCELLED",
                completedItems: 0,
                succeededItems: 0,
                failedItems: 0,
                skippedItems: 0,
                cancelledItems: 0,
                finishedAt: now,
            }),
        });
        expect(result.purgedSessionCount).toBe(1);
    });

    it("terminalizes queued and retryable runs with counters derived from their items", async () => {
        const now = new Date("2026-09-18T12:00:00.000Z");
        mocks.sessionFindMany.mockResolvedValue([{ id: "session_queued" }, { id: "session_retry" }]);
        mockLockedBatch(["session_queued", "session_retry"], ["run_queued", "run_retry"]);
        mocks.runFindMany.mockResolvedValue([
            { id: "run_queued", totalItems: 3 },
            { id: "run_retry", totalItems: 2 },
        ]);
        mocks.runItemUpdateMany
            .mockResolvedValueOnce({ count: 4 })
            .mockResolvedValueOnce({ count: 5 });
        mocks.runItemGroupBy.mockResolvedValue([
            { importRunId: "run_queued", status: "SUCCEEDED", _count: { _all: 1 } },
            { importRunId: "run_queued", status: "CANCELLED", _count: { _all: 2 } },
            { importRunId: "run_retry", status: "CANCELLED", _count: { _all: 2 } },
        ]);
        mocks.sessionDeleteMany.mockResolvedValue({ count: 2 });

        await ImportRetentionService.purgeExpiredStaging({ now });

        expect(mocks.runUpdate).toHaveBeenNthCalledWith(1, {
            where: { id: "run_queued" },
            data: expect.objectContaining({
                status: "CANCELLED",
                completedItems: 3,
                succeededItems: 1,
                cancelledItems: 2,
            }),
        });
        expect(mocks.runUpdate).toHaveBeenNthCalledWith(2, {
            where: { id: "run_retry" },
            data: expect.objectContaining({
                status: "CANCELLED",
                completedItems: 2,
                succeededItems: 0,
                cancelledItems: 2,
            }),
        });
    });

    it("locks a running ledger before cancelling its item lease and preserves completed results", async () => {
        const now = new Date("2026-09-18T12:00:00.000Z");
        mocks.sessionFindMany.mockResolvedValue([{ id: "session_running" }]);
        mockLockedBatch(["session_running"], ["run_running"]);
        mocks.runFindMany.mockResolvedValue([{ id: "run_running", totalItems: 2 }]);
        mocks.runItemUpdateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 2 });
        mocks.runItemGroupBy.mockResolvedValue([
            { importRunId: "run_running", status: "SUCCEEDED", _count: { _all: 1 } },
            { importRunId: "run_running", status: "CANCELLED", _count: { _all: 1 } },
        ]);
        mocks.sessionDeleteMany.mockResolvedValue({ count: 1 });

        await ImportRetentionService.purgeExpiredStaging({ now });

        expect(mocks.queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
            mocks.runItemUpdateMany.mock.invocationCallOrder[0]
        );
        expect(mocks.runItemUpdateMany).toHaveBeenNthCalledWith(1, {
            where: {
                importRunId: { in: ["run_running"] },
                status: { in: ["QUEUED", "RUNNING"] },
            },
            data: expect.objectContaining({
                status: "CANCELLED",
                payload: expect.anything(),
                result: expect.anything(),
                error: expect.anything(),
                leaseToken: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                finishedAt: now,
            }),
        });
        expect(mocks.runUpdate.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.sessionDeleteMany.mock.invocationCallOrder[0]
        );
    });

    it("is idempotent when the same daily job is delivered again", async () => {
        mocks.sessionFindMany
            .mockResolvedValueOnce([{ id: "session_1" }])
            .mockResolvedValueOnce([]);
        mockLockedBatch(["session_1"]);
        mocks.runItemUpdateMany.mockResolvedValueOnce({ count: 3 });
        mocks.sessionDeleteMany.mockResolvedValueOnce({ count: 1 });

        const first = await ImportRetentionService.purgeExpiredStaging();
        const second = await ImportRetentionService.purgeExpiredStaging();

        expect(first.purgedSessionCount).toBe(1);
        expect(second).toEqual({
            selectedCount: 0,
            scrubbedRunItemCount: 0,
            purgedSessionCount: 0,
            hasMore: false,
        });
        expect(mocks.transaction).toHaveBeenCalledTimes(1);
    });

    it("rechecks the purge deadline under lock before scrubbing or deleting", async () => {
        mocks.sessionFindMany.mockResolvedValue([{ id: "session_1" }]);
        mocks.queryRaw.mockResolvedValueOnce([]);

        const result = await ImportRetentionService.purgeExpiredStaging();

        expect(mocks.runFindMany).not.toHaveBeenCalled();
        expect(mocks.runItemUpdateMany).not.toHaveBeenCalled();
        expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
        expect(result).toEqual({
            selectedCount: 1,
            scrubbedRunItemCount: 0,
            purgedSessionCount: 0,
            hasMore: false,
        });
    });

    it("retries a serializable conflict without widening the purge batch", async () => {
        mocks.sessionFindMany.mockResolvedValue([{ id: "session_1" }]);
        mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("serialization failure"), { code: "P2034" }));
        mockLockedBatch(["session_1"]);
        mocks.sessionDeleteMany.mockResolvedValue({ count: 1 });

        const result = await ImportRetentionService.purgeExpiredStaging();

        expect(mocks.sessionFindMany).toHaveBeenCalledTimes(1);
        expect(mocks.transaction).toHaveBeenCalledTimes(2);
        expect(result.purgedSessionCount).toBe(1);
    });

    it("fails closed instead of writing counters that disagree with retained run items", async () => {
        mocks.sessionFindMany.mockResolvedValue([{ id: "session_1" }]);
        mockLockedBatch(["session_1"], ["run_1"]);
        mocks.runFindMany.mockResolvedValue([{ id: "run_1", totalItems: 2 }]);
        mocks.runItemUpdateMany.mockResolvedValueOnce({ count: 1 });
        mocks.runItemGroupBy.mockResolvedValue([
            { importRunId: "run_1", status: "CANCELLED", _count: { _all: 1 } },
        ]);

        await expect(ImportRetentionService.purgeExpiredStaging()).rejects.toThrow(
            "Import run item totals are inconsistent"
        );
        expect(mocks.runUpdate).not.toHaveBeenCalled();
        expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    });
});
