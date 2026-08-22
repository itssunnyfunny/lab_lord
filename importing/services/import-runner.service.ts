import crypto from "node:crypto";
import { Prisma } from "@/app/generated/prisma/client";
import type { ImportRunStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import type {
    ClaimImportRunBatchInput,
    ClaimedImportRunItem,
    CompleteImportRunItemInput,
    FailImportRunItemInput,
    HeartbeatImportRunItemInput,
    ImportRunItemResult,
    ImportRunProgress,
} from "../contracts/import-v2.contract";
import { syncImportSessionRunLifecycle } from "./import-run-lifecycle.service";

const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const MAX_LEASE_MS = 15 * 60 * 1000;
const TERMINAL_RUN_STATUSES: ImportRunStatus[] = [
    "COMPLETED",
    "COMPLETED_WITH_ISSUES",
    "PERMANENT_FAILURE",
    "CANCELLED",
    "SUPERSEDED",
];

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function normalizedLimit(value: number | undefined) {
    const limit = value ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Import runner batch size must be between 1 and 100");
    }
    return limit;
}

function normalizedLeaseMilliseconds(value: number | undefined) {
    const lease = value ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(lease) || lease < 10_000 || lease > MAX_LEASE_MS) {
        throw new Error("Import runner lease must be between 10 seconds and 15 minutes");
    }
    return lease;
}

function configurationDependencyLevel(payload: unknown) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
    return (payload as Record<string, unknown>).type === "multi-shift" ? 1 : 0;
}

function sanitizedError(input: { code: string; message: string; retryable: boolean }) {
    const code = input.code.trim().replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 80) || "IMPORT_ITEM_FAILED";
    const message = input.message.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500) || "Import item failed";
    return { code, message, retryable: input.retryable };
}

function redactedResult(input: ImportRunItemResult | undefined) {
    if (!input) return {};
    const entityIds = input.entityIds?.map(value => value.trim()).filter(Boolean) ?? [];
    if (entityIds.length > 100 || entityIds.some(value => value.length > 200)) {
        throw new Error("Import item result contains invalid entity ids");
    }
    const counts = Object.fromEntries(Object.entries(input.counts ?? {}).map(([key, value]) => {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !Number.isSafeInteger(value) || value < 0) {
            throw new Error("Import item result contains invalid counts");
        }
        return [key, value];
    }));
    return {
        ...(entityIds.length > 0 ? { entityIds } : {}),
        ...(Object.keys(counts).length > 0 ? { counts } : {}),
    };
}

function immutablePlanLeavesRowsUnresolved(plan: {
    blockedRows: number;
    skippedRows: number;
    snapshot: Prisma.JsonValue;
} | null) {
    if (!plan) return false;
    const snapshot = plan.snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        return plan.blockedRows > 0 || plan.skippedRows > 0;
    }
    const evaluations = Array.isArray((snapshot as Record<string, unknown>).evaluations)
        ? (snapshot as Record<string, unknown>).evaluations as unknown[]
        : null;
    const items = Array.isArray((snapshot as Record<string, unknown>).items)
        ? (snapshot as Record<string, unknown>).items as unknown[]
        : null;
    if (!evaluations || !items) return plan.blockedRows > 0 || plan.skippedRows > 0;
    const scheduledRowIds = new Set(items.flatMap(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const rowId = (item as Record<string, unknown>).rowId;
        return typeof rowId === "string" && rowId ? [rowId] : [];
    }));
    return evaluations.some(evaluation => {
        if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) return true;
        const record = evaluation as Record<string, unknown>;
        const rowId = typeof record.rowId === "string" ? record.rowId : "";
        const status = typeof record.status === "string" ? record.status : "";
        if (status === "IMPORTED") return false;
        if (record.skipped === true || status === "SKIPPED") return true;
        if (!["READY", "WARNING"].includes(status)) return true;
        return !rowId || !scheduledRowIds.has(rowId);
    });
}

async function terminalPlanLeavesRowsUnresolved(
    tx: Prisma.TransactionClient,
    plan: { id: string; blockedRows: number; skippedRows: number } | null
) {
    if (!plan) return false;
    if (plan.blockedRows > 0) return true;
    // The immutable snapshot is intentionally fetched only once, at terminal
    // projection. Pulling it for every item heartbeat/completion would make a
    // large historical-payment run transfer its full plan O(items²).
    const stored = await tx.importPlan.findUnique({
        where: { id: plan.id },
        select: { blockedRows: true, skippedRows: true, snapshot: true },
    });
    return stored
        ? immutablePlanLeavesRowsUnresolved(stored)
        : plan.skippedRows > 0;
}

async function refreshRunProgress(
    tx: Prisma.TransactionClient,
    importRunId: string,
    now: Date,
    requestedStatus?: ImportRunStatus
): Promise<ImportRunProgress> {
    const run = await tx.importRun.findUnique({
        where: { id: importRunId },
        include: {
            plan: { select: { id: true, blockedRows: true, skippedRows: true } },
        },
    });
    if (!run) throw new Error("Import run not found");
    const [succeededItems, failedItems, skippedItems, cancelledItems, queuedItems, runningItems] = await Promise.all([
        tx.importRunItem.count({ where: { importRunId, status: "SUCCEEDED" } }),
        tx.importRunItem.count({ where: { importRunId, status: "FAILED" } }),
        tx.importRunItem.count({ where: { importRunId, status: "SKIPPED" } }),
        tx.importRunItem.count({ where: { importRunId, status: "CANCELLED" } }),
        tx.importRunItem.count({ where: { importRunId, status: "QUEUED" } }),
        tx.importRunItem.count({ where: { importRunId, status: "RUNNING" } }),
    ]);
    const completedItems = succeededItems + failedItems + skippedItems + cancelledItems;
    let status = requestedStatus ?? run.status;
    let finishedAt = run.finishedAt;

    if (run.status === "CANCEL_REQUESTED" && queuedItems === 0 && runningItems === 0) {
        status = "CANCELLED";
        finishedAt = now;
    } else if (run.kind === "COMMIT" && queuedItems === 0 && runningItems === 0) {
        const planLeavesRowsUnresolved = failedItems === 0
            ? await terminalPlanLeavesRowsUnresolved(tx, run.plan)
            : false;
        status = failedItems === 0
            ? planLeavesRowsUnresolved
                ? "COMPLETED_WITH_ISSUES"
                : "COMPLETED"
            : succeededItems > 0
                ? "COMPLETED_WITH_ISSUES"
                : "PERMANENT_FAILURE";
        finishedAt = now;
    }

    const updated = await tx.importRun.update({
        where: { id: importRunId },
        data: {
            status,
            completedItems,
            succeededItems,
            failedItems,
            skippedItems,
            cancelledItems,
            finishedAt,
            lastHeartbeatAt: now,
        },
    });
    await syncImportSessionRunLifecycle(tx, updated, now);
    return {
        status: updated.status,
        totalItems: updated.totalItems,
        completedItems: updated.completedItems,
        succeededItems: updated.succeededItems,
        failedItems: updated.failedItems,
        skippedItems: updated.skippedItems,
        cancelledItems: updated.cancelledItems,
    };
}

export class ImportRunRunner {
    /** Machine-authenticated orchestration must call this only with a persisted run id. */
    static async claimBatch(input: ClaimImportRunBatchInput): Promise<ClaimedImportRunItem[]> {
        const now = input.now ?? new Date();
        const limit = normalizedLimit(input.limit);
        const leaseMilliseconds = normalizedLeaseMilliseconds(input.leaseMilliseconds);
        const workerId = input.workerId.trim().slice(0, 120);
        if (!workerId) throw new Error("Import runner worker id is required");

        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun" WHERE "id" = ${input.importRunId} FOR UPDATE
            `;
            const run = await tx.importRun.findUnique({
                where: { id: input.importRunId },
                include: { plan: { select: { readinessPolicy: true } } },
            });
            if (!run) throw new Error("Import run not found");
            if (run.kind !== "COMMIT" || TERMINAL_RUN_STATUSES.includes(run.status) || run.status === "WAITING_FOR_USER") {
                return [];
            }

            if (run.status === "CANCEL_REQUESTED") {
                await tx.importRunItem.updateMany({
                    where: { importRunId: run.id, status: "QUEUED" },
                    data: { status: "CANCELLED", payload: Prisma.DbNull, finishedAt: now },
                });
                await refreshRunProgress(tx, run.id, now);
                return [];
            }

            const expired = await tx.importRunItem.findMany({
                where: {
                    importRunId: run.id,
                    status: "RUNNING",
                    leaseExpiresAt: { lte: now },
                },
                select: { id: true, attemptCount: true },
            });
            for (const item of expired) {
                const exhausted = item.attemptCount >= run.maxAttempts;
                await tx.importRunItem.update({
                    where: { id: item.id },
                    data: exhausted ? {
                        status: "FAILED",
                        payload: Prisma.DbNull,
                        error: asJson({
                            code: "IMPORT_ITEM_LEASE_EXHAUSTED",
                            message: "Import item did not finish before its lease expired.",
                            retryable: false,
                        }),
                        leaseToken: null,
                        leaseOwner: null,
                        leaseExpiresAt: null,
                        finishedAt: now,
                    } : {
                        status: "QUEUED",
                        availableAt: now,
                        leaseToken: null,
                        leaseOwner: null,
                        leaseExpiresAt: null,
                    },
                });
            }

            if (
                run.plan?.readinessPolicy === "REQUIRE_ALL_ROWS_READY"
                && expired.some(item => item.attemptCount >= run.maxAttempts)
            ) {
                await tx.importRunItem.updateMany({
                    where: {
                        importRunId: run.id,
                        status: { in: ["QUEUED", "RUNNING"] },
                    },
                    data: {
                        status: "SKIPPED",
                        payload: Prisma.DbNull,
                        error: Prisma.DbNull,
                        leaseToken: null,
                        leaseOwner: null,
                        leaseExpiresAt: null,
                        lastHeartbeatAt: now,
                        finishedAt: now,
                    },
                });
                await refreshRunProgress(tx, run.id, now);
                return [];
            }

            // A Workflow step retry uses the same deterministic worker id. If
            // the process stopped after claiming but before finishing all 25
            // items, resume those still-valid leases instead of waiting for
            // expiry or claiming overlapping work.
            const owned = await tx.importRunItem.findMany({
                where: {
                    importRunId: run.id,
                    status: "RUNNING",
                    leaseOwner: workerId,
                    leaseExpiresAt: { gt: now },
                },
                orderBy: { ordinal: "asc" },
                include: {
                    row: { select: { rowNumber: true } },
                    evaluation: {
                        select: {
                            mappedData: true,
                            normalizedData: true,
                            issues: true,
                            warnings: true,
                        },
                    },
                },
            });
            if (owned.length > 0) {
                return owned.map(item => ({
                    id: item.id,
                    importRunId: item.importRunId,
                    importRowId: item.importRowId,
                    evaluationId: item.evaluationId,
                    ordinal: item.ordinal,
                    itemKey: item.itemKey,
                    kind: item.kind,
                    idempotencyKey: item.idempotencyKey,
                    requestHash: item.requestHash,
                    leaseToken: item.leaseToken!,
                    attemptCount: item.attemptCount,
                    rowNumber: item.row?.rowNumber ?? null,
                    payload: item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
                        ? item.payload as Record<string, unknown>
                        : null,
                    mappedData: item.evaluation?.mappedData ?? null,
                    normalizedData: item.evaluation?.normalizedData as ClaimedImportRunItem["normalizedData"],
                    issues: Array.isArray(item.evaluation?.issues) ? item.evaluation.issues as ClaimedImportRunItem["issues"] : [],
                    warnings: Array.isArray(item.evaluation?.warnings) ? item.evaluation.warnings as ClaimedImportRunItem["warnings"] : [],
                }));
            }

            const runningCount = await tx.importRunItem.count({
                where: { importRunId: run.id, status: "RUNNING" },
            });
            if (runningCount > 0) {
                await refreshRunProgress(tx, run.id, now, "RUNNING");
                return [];
            }

            const firstQueued = await tx.importRunItem.findFirst({
                where: { importRunId: run.id, status: "QUEUED" },
                orderBy: { ordinal: "asc" },
                select: { kind: true, availableAt: true, payload: true },
            });
            if (!firstQueued) {
                await refreshRunProgress(tx, run.id, now);
                return [];
            }
            if (firstQueued.availableAt > now) {
                await refreshRunProgress(tx, run.id, now, "RETRYABLE_FAILURE");
                return [];
            }
            const candidatePool = await tx.importRunItem.findMany({
                where: {
                    importRunId: run.id,
                    status: "QUEUED",
                    kind: firstQueued.kind,
                    availableAt: { lte: now },
                },
                orderBy: { ordinal: "asc" },
                take: limit,
                select: { id: true, payload: true },
            });
            // CONFIG is one ledger kind but has two dependency levels: seats
            // and shifts must settle before a multi-shift can resolve its
            // component shifts. Keep the existing batching semantics for all
            // other kinds while fencing CONFIG claims to the earliest level.
            const configurationLevel = firstQueued.kind === "CONFIG"
                ? configurationDependencyLevel(firstQueued.payload)
                : null;
            const candidates = configurationLevel === null
                ? candidatePool
                : candidatePool.filter(candidate =>
                    configurationDependencyLevel(candidate.payload) === configurationLevel
                );
            const claimedIds: string[] = [];
            for (const candidate of candidates) {
                const leaseToken = crypto.randomUUID();
                const claimed = await tx.importRunItem.updateMany({
                    where: { id: candidate.id, importRunId: run.id, status: "QUEUED" },
                    data: {
                        status: "RUNNING",
                        attemptCount: { increment: 1 },
                        leaseToken,
                        leaseOwner: workerId,
                        leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds),
                        lastHeartbeatAt: now,
                        startedAt: now,
                        error: Prisma.DbNull,
                    },
                });
                if (claimed.count === 1) claimedIds.push(candidate.id);
            }
            if (claimedIds.length === 0) return [];

            await tx.importRun.update({
                where: { id: run.id },
                data: {
                    status: "RUNNING",
                    startedAt: run.startedAt ?? now,
                    lastHeartbeatAt: now,
                },
            });
            const claimed = await tx.importRunItem.findMany({
                where: { id: { in: claimedIds } },
                orderBy: { ordinal: "asc" },
                include: {
                    row: { select: { rowNumber: true } },
                    evaluation: {
                        select: {
                            mappedData: true,
                            normalizedData: true,
                            issues: true,
                            warnings: true,
                        },
                    },
                },
            });
            return claimed.map(item => ({
                id: item.id,
                importRunId: item.importRunId,
                importRowId: item.importRowId,
                evaluationId: item.evaluationId,
                ordinal: item.ordinal,
                itemKey: item.itemKey,
                kind: item.kind,
                idempotencyKey: item.idempotencyKey,
                requestHash: item.requestHash,
                leaseToken: item.leaseToken!,
                attemptCount: item.attemptCount,
                rowNumber: item.row?.rowNumber ?? null,
                payload: item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
                    ? item.payload as Record<string, unknown>
                    : null,
                mappedData: item.evaluation?.mappedData ?? null,
                normalizedData: item.evaluation?.normalizedData as ClaimedImportRunItem["normalizedData"],
                issues: Array.isArray(item.evaluation?.issues) ? item.evaluation.issues as ClaimedImportRunItem["issues"] : [],
                warnings: Array.isArray(item.evaluation?.warnings) ? item.evaluation.warnings as ClaimedImportRunItem["warnings"] : [],
            }));
        }, { timeout: 30_000 });
    }

    static async heartbeatItem(input: HeartbeatImportRunItemInput) {
        const now = input.now ?? new Date();
        const leaseMilliseconds = normalizedLeaseMilliseconds(input.leaseMilliseconds);
        const renewed = await prisma.importRunItem.updateMany({
            where: {
                id: input.itemId,
                importRunId: input.importRunId,
                status: "RUNNING",
                leaseToken: input.leaseToken,
            },
            data: {
                leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds),
                lastHeartbeatAt: now,
            },
        });
        if (renewed.count !== 1) throw new Error("Import item lease was lost");
        await prisma.importRun.updateMany({
            where: { id: input.importRunId, status: "RUNNING" },
            data: { lastHeartbeatAt: now },
        });
    }

    static async completeItem(input: CompleteImportRunItemInput) {
        return prisma.$transaction(
            tx => this.completeItemInTransaction(tx, input),
            { timeout: 30_000 }
        );
    }

    /** Commits a domain mutation and its durable success marker in the caller's transaction. */
    static async completeItemInTransaction(
        tx: Prisma.TransactionClient,
        input: CompleteImportRunItemInput
    ) {
        const now = input.now ?? new Date();
        await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "ImportRun" WHERE "id" = ${input.importRunId} FOR UPDATE
        `;
        const current = await tx.importRunItem.findFirst({
            where: { id: input.itemId, importRunId: input.importRunId },
            select: { status: true },
        });
        if (current?.status === "SUCCEEDED") {
            return refreshRunProgress(tx, input.importRunId, now);
        }
        const completed = await tx.importRunItem.updateMany({
            where: {
                id: input.itemId,
                importRunId: input.importRunId,
                status: "RUNNING",
                leaseToken: input.leaseToken,
            },
            data: {
                status: "SUCCEEDED",
                payload: Prisma.DbNull,
                result: asJson(redactedResult(input.result)),
                error: Prisma.DbNull,
                leaseToken: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                lastHeartbeatAt: now,
                finishedAt: now,
            },
        });
        if (completed.count !== 1) throw new Error("Import item lease was lost");
        return refreshRunProgress(tx, input.importRunId, now);
    }

    static async failItem(input: FailImportRunItemInput) {
        const now = input.now ?? new Date();
        const retryDelay = Math.max(0, Math.min(input.retryDelayMilliseconds ?? 0, 24 * 60 * 60 * 1000));
        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun" WHERE "id" = ${input.importRunId} FOR UPDATE
            `;
            const run = await tx.importRun.findUnique({
                where: { id: input.importRunId },
                include: { plan: { select: { readinessPolicy: true } } },
            });
            const item = await tx.importRunItem.findFirst({
                where: {
                    id: input.itemId,
                    importRunId: input.importRunId,
                },
            });
            if (!run || !item) throw new Error("Import item lease was lost");
            if (["SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED", "QUEUED"].includes(item.status)) {
                return refreshRunProgress(tx, input.importRunId, now);
            }
            if (item.leaseToken !== input.leaseToken) throw new Error("Import item lease was lost");
            const retry = input.error.retryable
                && item.attemptCount < run.maxAttempts
                && run.status !== "CANCEL_REQUESTED";
            const cancelled = run.status === "CANCEL_REQUESTED";
            await tx.importRunItem.update({
                where: { id: item.id },
                data: retry ? {
                    status: "QUEUED",
                    availableAt: new Date(now.getTime() + retryDelay),
                    error: asJson(sanitizedError(input.error)),
                    leaseToken: null,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    lastHeartbeatAt: now,
                } : {
                    status: cancelled ? "CANCELLED" : "FAILED",
                    payload: Prisma.DbNull,
                    error: cancelled ? Prisma.DbNull : asJson(sanitizedError({ ...input.error, retryable: false })),
                    leaseToken: null,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    lastHeartbeatAt: now,
                    finishedAt: now,
                },
            });
            const safetyStop = ["IMPORT_AUTHORIZATION_REVOKED", "IMPORT_PLAN_STALE"].includes(input.error.code);
            if (!retry && !cancelled && (safetyStop || run.plan?.readinessPolicy === "REQUIRE_ALL_ROWS_READY")) {
                await tx.importRunItem.updateMany({
                    where: {
                        importRunId: run.id,
                        id: { not: item.id },
                        status: { in: ["QUEUED", "RUNNING"] },
                    },
                    data: {
                        status: "SKIPPED",
                        payload: Prisma.DbNull,
                        error: Prisma.DbNull,
                        leaseToken: null,
                        leaseOwner: null,
                        leaseExpiresAt: null,
                        lastHeartbeatAt: now,
                        finishedAt: now,
                    },
                });
            }
            return refreshRunProgress(
                tx,
                run.id,
                now,
                retry ? "RETRYABLE_FAILURE" : undefined
            );
        }, { timeout: 30_000 });
    }

    static async finalizeRun(importRunId: string, now = new Date()) {
        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun" WHERE "id" = ${importRunId} FOR UPDATE
            `;
            return refreshRunProgress(tx, importRunId, now);
        }, { timeout: 30_000 });
    }

    static async finalizeExhaustedCommitRun(importRunId: string, now = new Date()) {
        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun" WHERE "id" = ${importRunId} FOR UPDATE
            `;
            const run = await tx.importRun.findUnique({
                where: { id: importRunId },
                include: { plan: { select: { readinessPolicy: true } } },
            });
            if (!run || run.kind !== "COMMIT") throw new Error("Import commit run not found");
            if (TERMINAL_RUN_STATUSES.includes(run.status)) {
                return {
                    status: run.status,
                    totalItems: run.totalItems,
                    completedItems: run.completedItems,
                    succeededItems: run.succeededItems,
                    failedItems: run.failedItems,
                    skippedItems: run.skippedItems,
                    cancelledItems: run.cancelledItems,
                };
            }

            const activeItems = await tx.importRunItem.findMany({
                where: { importRunId, status: { in: ["QUEUED", "RUNNING"] } },
                orderBy: { ordinal: "asc" },
                select: { id: true },
            });
            const activeIds = activeItems.map(item => item.id);
            const failure = sanitizedError({
                code: "IMPORT_COMMIT_RETRY_EXHAUSTED",
                message: "Import execution could not continue after bounded Workflow retries.",
                retryable: false,
            });

            if (run.status === "CANCEL_REQUESTED") {
                if (activeIds.length > 0) {
                    await tx.importRunItem.updateMany({
                        where: { id: { in: activeIds }, importRunId },
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
                }
                await tx.importRun.update({
                    where: { id: importRunId },
                    data: { error: Prisma.DbNull, lastHeartbeatAt: now },
                });
            } else if (
                run.plan?.readinessPolicy === "REQUIRE_ALL_ROWS_READY"
                && activeItems.length > 0
            ) {
                const [failedItem, ...skippedItems] = activeItems;
                await tx.importRunItem.update({
                    where: { id: failedItem.id },
                    data: {
                        status: "FAILED",
                        payload: Prisma.DbNull,
                        result: Prisma.DbNull,
                        error: asJson(failure),
                        leaseToken: null,
                        leaseOwner: null,
                        leaseExpiresAt: null,
                        lastHeartbeatAt: now,
                        finishedAt: now,
                    },
                });
                if (skippedItems.length > 0) {
                    await tx.importRunItem.updateMany({
                        where: { id: { in: skippedItems.map(item => item.id) }, importRunId },
                        data: {
                            status: "SKIPPED",
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
                }
                await tx.importRun.update({
                    where: { id: importRunId },
                    data: { error: asJson(failure), lastHeartbeatAt: now },
                });
            } else {
                if (activeIds.length > 0) {
                    await tx.importRunItem.updateMany({
                        where: { id: { in: activeIds }, importRunId },
                        data: {
                            status: "FAILED",
                            payload: Prisma.DbNull,
                            result: Prisma.DbNull,
                            error: asJson(failure),
                            leaseToken: null,
                            leaseOwner: null,
                            leaseExpiresAt: null,
                            lastHeartbeatAt: now,
                            finishedAt: now,
                        },
                    });
                }
                await tx.importRun.update({
                    where: { id: importRunId },
                    data: { error: asJson(failure), lastHeartbeatAt: now },
                });
            }

            return refreshRunProgress(tx, importRunId, now);
        }, { timeout: 30_000 });
    }

    static async setAnalysisStatus(input: {
        importRunId: string;
        status: "RUNNING" | "WAITING_FOR_USER" | "COMPLETED" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE";
        error?: { code: string; message: string; retryable: boolean };
        now?: Date;
    }) {
        const now = input.now ?? new Date();
        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun" WHERE "id" = ${input.importRunId} FOR UPDATE
            `;
            const run = await tx.importRun.findUnique({ where: { id: input.importRunId } });
            if (!run || run.kind !== "ANALYSIS") throw new Error("Import analysis run not found");
            if (TERMINAL_RUN_STATUSES.includes(run.status)) return run;
            if (run.status === "CANCEL_REQUESTED") {
                const cancelled = await tx.importRun.update({
                    where: { id: run.id },
                    data: { status: "CANCELLED", finishedAt: now, lastHeartbeatAt: now },
                });
                await syncImportSessionRunLifecycle(tx, cancelled, now);
                return cancelled;
            }
            const updated = await tx.importRun.update({
                where: { id: run.id },
                data: {
                    status: input.status,
                    error: input.error ? asJson(sanitizedError(input.error)) : Prisma.DbNull,
                    lastHeartbeatAt: now,
                    ...(input.status === "COMPLETED" || input.status === "PERMANENT_FAILURE"
                        ? { finishedAt: now }
                        : {}),
                },
            });
            await syncImportSessionRunLifecycle(tx, updated, now);
            return updated;
        }, { timeout: 30_000 });
    }
}
