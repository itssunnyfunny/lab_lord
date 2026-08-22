import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        importRunItem: {
            updateMany: vi.fn(),
            update: vi.fn(),
            count: vi.fn(),
            findFirst: vi.fn(),
            findMany: vi.fn(),
        },
        importRun: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        importPlan: { findUnique: vi.fn() },
    };
    return {
        tx,
        transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
});

vi.mock("@/lib/prisma", () => ({
    prisma: { $transaction: mocks.transaction },
}));

describe("ImportRunRunner", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "run_1" }]);
        mocks.tx.importRunItem.updateMany.mockResolvedValue({ count: 1 });
        mocks.tx.importRunItem.findFirst.mockResolvedValue({ status: "RUNNING" });
        mocks.tx.importPlan.findUnique.mockResolvedValue({
            blockedRows: 0,
            skippedRows: 0,
            snapshot: { evaluations: [], items: [] },
        });
        mocks.tx.importRun.findUnique.mockResolvedValue({
            id: "run_1",
            kind: "COMMIT",
            status: "RUNNING",
            finishedAt: null,
            totalItems: 1,
        });
        mocks.tx.importRunItem.count.mockImplementation(async ({ where }: { where: { status: string } }) =>
            where.status === "SUCCEEDED" ? 1 : 0
        );
        mocks.tx.importRun.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            totalItems: 1,
            completedItems: 1,
            succeededItems: 1,
            failedItems: 0,
            skippedItems: 0,
            cancelledItems: 0,
            ...data,
        }));
    });

    it("fences completion by lease and persists only redacted IDs/counts", async () => {
        const { ImportRunRunner } = await import("@/importing/services/import-runner.service");
        const progress = await ImportRunRunner.completeItem({
            importRunId: "run_1",
            itemId: "item_1",
            leaseToken: "lease_1",
            result: { entityIds: ["student_1"], counts: { students: 1 } },
            now: new Date("2026-08-18T00:00:00.000Z"),
        });

        expect(mocks.tx.importRunItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ leaseToken: "lease_1", status: "RUNNING" }),
            data: expect.objectContaining({
                status: "SUCCEEDED",
                result: { entityIds: ["student_1"], counts: { students: 1 } },
                leaseToken: null,
            }),
        }));
        expect(progress.status).toBe("COMPLETED");
        expect(mocks.tx.importRun.findUnique).toHaveBeenCalledWith({
            where: { id: "run_1" },
            include: {
                plan: { select: { id: true, blockedRows: true, skippedRows: true } },
            },
        });
    });

    it("keeps a successful ready-only run partial when its immutable plan leaves rows unresolved", async () => {
        mocks.tx.importRun.findUnique.mockResolvedValue({
            id: "run_1",
            kind: "COMMIT",
            status: "RUNNING",
            finishedAt: null,
            totalItems: 1,
            plan: {
                id: "plan_1",
                blockedRows: 1,
                skippedRows: 0,
                snapshot: {
                    evaluations: [
                        { rowId: "row_ready", status: "READY", skipped: false },
                        { rowId: "row_blocked", status: "BLOCKED", skipped: false },
                    ],
                    items: [{ rowId: "row_ready", kind: "STUDENT" }],
                },
            },
        });
        const { ImportRunRunner } = await import("@/importing/services/import-runner.service");

        const progress = await ImportRunRunner.completeItem({
            importRunId: "run_1",
            itemId: "item_1",
            leaseToken: "lease_1",
            result: { entityIds: ["student_1"], counts: { students: 1 } },
            now: new Date("2026-08-18T00:00:00.000Z"),
        });

        expect(progress.status).toBe("COMPLETED_WITH_ISSUES");
        expect(mocks.tx.importRun.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: "COMPLETED_WITH_ISSUES" }),
        }));
        expect(mocks.tx.importPlan.findUnique).not.toHaveBeenCalled();
    });

    it("rejects non-redacted result shapes before finalizing an item", async () => {
        const { ImportRunRunner } = await import("@/importing/services/import-runner.service");

        await expect(ImportRunRunner.completeItem({
            importRunId: "run_1",
            itemId: "item_1",
            leaseToken: "lease_1",
            result: { counts: { "student name": 1 } },
        })).rejects.toThrow("invalid counts");
    });

    it("keeps a requeued shift ahead of its dependent multi-shift configuration", async () => {
        const now = new Date("2026-08-18T00:00:00.000Z");
        const items = [
            {
                id: "shift_item",
                importRunId: "run_1",
                importRowId: "row_1",
                evaluationId: "evaluation_1",
                ordinal: 0,
                itemKey: "config:shift:morning",
                kind: "CONFIG",
                idempotencyKey: "run_1:config:shift:morning",
                requestHash: "shift_hash",
                status: "QUEUED",
                attemptCount: 1,
                availableAt: now,
                payload: { type: "shift", name: "Morning" },
                leaseToken: null as string | null,
                leaseOwner: null as string | null,
                leaseExpiresAt: null as Date | null,
                row: { rowNumber: 2 },
                evaluation: { mappedData: {}, normalizedData: {}, issues: [], warnings: [] },
            },
            {
                id: "multi_shift_item",
                importRunId: "run_1",
                importRowId: "row_1",
                evaluationId: "evaluation_1",
                ordinal: 1,
                itemKey: "config:multi-shift:full-day",
                kind: "CONFIG",
                idempotencyKey: "run_1:config:multi-shift:full-day",
                requestHash: "multi_shift_hash",
                status: "QUEUED",
                attemptCount: 0,
                availableAt: now,
                payload: { type: "multi-shift", name: "Full day", componentShiftNames: ["Morning"] },
                leaseToken: null as string | null,
                leaseOwner: null as string | null,
                leaseExpiresAt: null as Date | null,
                row: { rowNumber: 2 },
                evaluation: { mappedData: {}, normalizedData: {}, issues: [], warnings: [] },
            },
        ];
        mocks.tx.importRun.findUnique.mockResolvedValue({
            id: "run_1",
            kind: "COMMIT",
            status: "RETRYABLE_FAILURE",
            finishedAt: null,
            startedAt: now,
            totalItems: 2,
            maxAttempts: 3,
            plan: { readinessPolicy: "READY_ROWS_ONLY" },
        });
        mocks.tx.importRunItem.count.mockResolvedValue(0);
        mocks.tx.importRunItem.findFirst.mockImplementation(async () =>
            items.filter(item => item.status === "QUEUED").sort((left, right) => left.ordinal - right.ordinal)[0] ?? null
        );
        mocks.tx.importRunItem.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
            if (where.status === "RUNNING") return [];
            if (where.status === "QUEUED") {
                return items.filter(item => item.status === "QUEUED").sort((left, right) => left.ordinal - right.ordinal);
            }
            const ids = (where.id as { in?: string[] } | undefined)?.in;
            return ids ? items.filter(item => ids.includes(item.id)) : [];
        });
        mocks.tx.importRunItem.updateMany.mockImplementation(async ({ where, data }: {
            where: { id?: string; status?: string };
            data: Record<string, unknown>;
        }) => {
            const item = items.find(candidate => candidate.id === where.id && candidate.status === where.status);
            if (!item) return { count: 0 };
            item.status = String(data.status);
            item.attemptCount += 1;
            item.leaseToken = String(data.leaseToken);
            item.leaseOwner = String(data.leaseOwner);
            item.leaseExpiresAt = data.leaseExpiresAt as Date;
            return { count: 1 };
        });
        mocks.tx.importRun.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "run_1",
            totalItems: 2,
            ...data,
        }));
        const { ImportRunRunner } = await import("@/importing/services/import-runner.service");

        const retryClaim = await ImportRunRunner.claimBatch({
            importRunId: "run_1",
            workerId: "worker_retry",
            limit: 25,
            now,
        });

        expect(retryClaim.map(item => item.id)).toEqual(["shift_item"]);
        expect(items[1].status).toBe("QUEUED");

        items[0].status = "SUCCEEDED";
        items[0].leaseToken = null;
        items[0].leaseOwner = null;
        items[0].leaseExpiresAt = null;
        const dependentClaim = await ImportRunRunner.claimBatch({
            importRunId: "run_1",
            workerId: "worker_after_shift",
            limit: 25,
            now,
        });

        expect(dependentClaim.map(item => item.id)).toEqual(["multi_shift_item"]);
    });

    it("terminalizes every remaining independent item after commit Workflow retries exhaust", async () => {
        const now = new Date("2026-08-18T01:00:00.000Z");
        mocks.tx.importRun.findUnique.mockResolvedValue({
            id: "run_1",
            kind: "COMMIT",
            status: "RUNNING",
            finishedAt: null,
            totalItems: 3,
            plan: { readinessPolicy: "READY_ROWS_ONLY" },
        });
        mocks.tx.importRunItem.findMany.mockResolvedValue([{ id: "item_2" }, { id: "item_3" }]);
        mocks.tx.importRunItem.count.mockImplementation(async ({ where }: { where: { status: string } }) => ({
            SUCCEEDED: 1,
            FAILED: 2,
            SKIPPED: 0,
            CANCELLED: 0,
            QUEUED: 0,
            RUNNING: 0,
        }[where.status] ?? 0));
        const { ImportRunRunner } = await import("@/importing/services/import-runner.service");

        const result = await ImportRunRunner.finalizeExhaustedCommitRun("run_1", now);

        expect(result).toMatchObject({ status: "COMPLETED_WITH_ISSUES", failedItems: 2 });
        expect(mocks.tx.importRunItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: { in: ["item_2", "item_3"] }, importRunId: "run_1" },
            data: expect.objectContaining({
                status: "FAILED",
                leaseToken: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                finishedAt: now,
                error: expect.objectContaining({ code: "IMPORT_COMMIT_RETRY_EXHAUSTED", retryable: false }),
            }),
        }));
    });

    it("fails one item and skips unscheduled work for require-all policy exhaustion", async () => {
        const now = new Date("2026-08-18T01:00:00.000Z");
        mocks.tx.importRun.findUnique.mockResolvedValue({
            id: "run_1",
            kind: "COMMIT",
            status: "RUNNING",
            finishedAt: null,
            totalItems: 3,
            plan: { readinessPolicy: "REQUIRE_ALL_ROWS_READY" },
        });
        mocks.tx.importRunItem.findMany.mockResolvedValue([
            { id: "item_1" },
            { id: "item_2" },
            { id: "item_3" },
        ]);
        mocks.tx.importRunItem.count.mockImplementation(async ({ where }: { where: { status: string } }) => ({
            SUCCEEDED: 0,
            FAILED: 1,
            SKIPPED: 2,
            CANCELLED: 0,
            QUEUED: 0,
            RUNNING: 0,
        }[where.status] ?? 0));
        const { ImportRunRunner } = await import("@/importing/services/import-runner.service");

        const result = await ImportRunRunner.finalizeExhaustedCommitRun("run_1", now);

        expect(result).toMatchObject({ status: "PERMANENT_FAILURE", failedItems: 1, skippedItems: 2 });
        expect(mocks.tx.importRunItem.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "item_1" },
            data: expect.objectContaining({ status: "FAILED" }),
        }));
        expect(mocks.tx.importRunItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: { in: ["item_2", "item_3"] }, importRunId: "run_1" },
            data: expect.objectContaining({ status: "SKIPPED", error: expect.anything() }),
        }));
    });

    it("replays commit exhaustion without changing an already-terminal ledger", async () => {
        mocks.tx.importRun.findUnique.mockResolvedValue({
            id: "run_1",
            kind: "COMMIT",
            status: "COMPLETED_WITH_ISSUES",
            totalItems: 2,
            completedItems: 2,
            succeededItems: 1,
            failedItems: 1,
            skippedItems: 0,
            cancelledItems: 0,
        });
        const { ImportRunRunner } = await import("@/importing/services/import-runner.service");

        await expect(ImportRunRunner.finalizeExhaustedCommitRun("run_1")).resolves.toMatchObject({
            status: "COMPLETED_WITH_ISSUES",
            completedItems: 2,
        });
        expect(mocks.tx.importRunItem.findMany).not.toHaveBeenCalled();
        expect(mocks.tx.importRunItem.updateMany).not.toHaveBeenCalled();
    });
});
