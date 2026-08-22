import { Prisma } from "@/app/generated/prisma/client";
import type { ImportRunStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

export const DEFAULT_IMPORT_PURGE_BATCH_SIZE = 25;
export const MAX_IMPORT_PURGE_BATCH_SIZE = 100;

export const ACTIVE_IMPORT_RUN_STATUSES: ImportRunStatus[] = [
    "QUEUED",
    "RUNNING",
    "WAITING_FOR_USER",
    "RETRYABLE_FAILURE",
    "CANCEL_REQUESTED",
];

export type PurgeExpiredImportStagingInput = {
    now?: Date;
    limit?: number;
};

function parseLimit(value: number | undefined) {
    const limit = value ?? DEFAULT_IMPORT_PURGE_BATCH_SIZE;
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("Import purge batch size must be a positive integer");
    }
    return Math.min(limit, MAX_IMPORT_PURGE_BATCH_SIZE);
}

function eligibleSessionWhere(now: Date) {
    return {
        purgeAfter: { lte: now },
    } as const;
}

function isSerializableConflict(error: unknown) {
    return Boolean(
        error
        && typeof error === "object"
        && "code" in error
        && error.code === "P2034"
    );
}

type ImportRunItemProgress = {
    succeededItems: number;
    failedItems: number;
    skippedItems: number;
    cancelledItems: number;
};

function emptyRunItemProgress(): ImportRunItemProgress {
    return {
        succeededItems: 0,
        failedItems: 0,
        skippedItems: 0,
        cancelledItems: 0,
    };
}

async function purgeExpiredCandidateBatch(
    transaction: Prisma.TransactionClient,
    candidateIds: string[],
    now: Date
) {
    // Lock the staging records before looking at their runs. This prevents a
    // concurrent draft refresh or new run from racing the terminalization and
    // delete below. Existing runner transactions either finish first or lose
    // their lease/status compare-and-set after these locks commit.
    const lockedSessions = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "ImportSession"
        WHERE "id" IN (${Prisma.join(candidateIds)})
          AND "purgeAfter" <= ${now}
        ORDER BY "id"
        FOR UPDATE
    `;
    const eligibleIds = lockedSessions.map(session => session.id);
    if (eligibleIds.length === 0) {
        return { scrubbedRunItemCount: 0, purgedSessionCount: 0 };
    }

    await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "ImportRun"
        WHERE "importSessionId" IN (${Prisma.join(eligibleIds)})
        ORDER BY "id"
        FOR UPDATE
    `;
    const activeRuns = await transaction.importRun.findMany({
        where: {
            importSessionId: { in: eligibleIds },
            status: { in: ACTIVE_IMPORT_RUN_STATUSES },
        },
        orderBy: { id: "asc" },
        select: { id: true, totalItems: true },
    });
    const activeRunIds = activeRuns.map(run => run.id);

    if (activeRunIds.length > 0) {
        await transaction.importRunItem.updateMany({
            where: {
                importRunId: { in: activeRunIds },
                status: { in: ["QUEUED", "RUNNING"] },
            },
            data: {
                status: "CANCELLED",
                payload: Prisma.DbNull,
                result: Prisma.DbNull,
                error: Prisma.DbNull,
                leaseToken: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                lastHeartbeatAt: now,
                finishedAt: now,
            },
        });

        const groupedCounts = await transaction.importRunItem.groupBy({
            by: ["importRunId", "status"],
            where: { importRunId: { in: activeRunIds } },
            _count: { _all: true },
        });
        const progressByRun = new Map<string, ImportRunItemProgress>();
        for (const group of groupedCounts) {
            const progress = progressByRun.get(group.importRunId) ?? emptyRunItemProgress();
            if (group.status === "SUCCEEDED") progress.succeededItems = group._count._all;
            if (group.status === "FAILED") progress.failedItems = group._count._all;
            if (group.status === "SKIPPED") progress.skippedItems = group._count._all;
            if (group.status === "CANCELLED") progress.cancelledItems = group._count._all;
            progressByRun.set(group.importRunId, progress);
        }

        for (const run of activeRuns) {
            const progress = progressByRun.get(run.id) ?? emptyRunItemProgress();
            const completedItems = progress.succeededItems
                + progress.failedItems
                + progress.skippedItems
                + progress.cancelledItems;
            if (completedItems !== run.totalItems) {
                throw new Error("Import run item totals are inconsistent; staging purge was stopped");
            }
            await transaction.importRun.update({
                where: { id: run.id },
                data: {
                    status: "CANCELLED",
                    completedItems,
                    ...progress,
                    error: Prisma.DbNull,
                    finishedAt: now,
                    lastHeartbeatAt: now,
                },
            });
        }
    }

    const scrubbed = await transaction.importRunItem.updateMany({
        where: {
            run: { importSessionId: { in: eligibleIds } },
        },
        data: {
            payload: Prisma.DbNull,
            error: Prisma.DbNull,
        },
    });
    const purged = await transaction.importSession.deleteMany({
        where: {
            id: { in: eligibleIds },
            ...eligibleSessionWhere(now),
        },
    });
    return {
        scrubbedRunItemCount: scrubbed.count,
        purgedSessionCount: purged.count,
    };
}

export class ImportRetentionService {
    static async countExpiredStaging(now = new Date()) {
        if (Number.isNaN(now.getTime())) throw new Error("Import purge cutoff is invalid");
        return prisma.importSession.count({ where: eligibleSessionWhere(now) });
    }

    static async purgeExpiredStaging(input: PurgeExpiredImportStagingInput = {}) {
        const now = input.now ?? new Date();
        if (Number.isNaN(now.getTime())) throw new Error("Import purge cutoff is invalid");
        const limit = parseLimit(input.limit);

        const candidates = await prisma.importSession.findMany({
            where: eligibleSessionWhere(now),
            orderBy: [{ purgeAfter: "asc" }, { id: "asc" }],
            take: limit + 1,
            select: { id: true },
        });
        const candidateIds = candidates.slice(0, limit).map(candidate => candidate.id);
        if (candidateIds.length === 0) {
            return {
                selectedCount: 0,
                scrubbedRunItemCount: 0,
                purgedSessionCount: 0,
                hasMore: false,
            };
        }

        let result: Awaited<ReturnType<typeof purgeExpiredCandidateBatch>> | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                result = await prisma.$transaction(
                    transaction => purgeExpiredCandidateBatch(transaction, candidateIds, now),
                    {
                        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                        timeout: 30_000,
                    }
                );
                break;
            } catch (error) {
                if (!isSerializableConflict(error) || attempt === 2) throw error;
            }
        }
        if (!result) throw new Error("Import staging purge did not complete");

        return {
            selectedCount: candidateIds.length,
            ...result,
            hasMore: candidates.length > limit,
        };
    }
}
