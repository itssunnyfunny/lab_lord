import { AccessPolicy } from "@/services/accessPolicy.service";
import { prisma } from "@/lib/prisma";
import { StaffService } from "@/services/staff.service";
import { Prisma } from "@/app/generated/prisma/client";
import type { ImportRunStatus } from "@/app/generated/prisma/enums";
import type { StaffAction } from "@/types";
import { getImportMaxPlannedMutations } from "@/lib/importFeature";
import {
    IMPORT_ENGINE_VERSION,
    IMPORT_PLAN_SCHEMA_VERSION,
    type AttachImportWorkflowRunInput,
    type CreateImportRunInput,
    type ImportPlanSnapshot,
} from "../contracts/import-v2.contract";
import {
    assertImportPlanWithinMutationLimit,
    createImportMutationRequestHash,
    createImportRequestHash,
} from "../utils/import-plan-compiler";
import { ImportIdempotencyConflictError, ImportRevisionConflictError } from "../utils/import-errors";
import { importStagingPurgeAfter } from "../utils/import-retention";
import { isImportRunDispatchRequired } from "../utils/import-run-dispatch";
import { syncImportSessionRunLifecycle } from "./import-run-lifecycle.service";
import { assertImportPlanConfigurationCurrent } from "./import-plan-configuration.service";

const ACTIVE_RUN_STATUSES: ImportRunStatus[] = [
    "QUEUED",
    "RUNNING",
    "WAITING_FOR_USER",
    "RETRYABLE_FAILURE",
    "CANCEL_REQUESTED",
];
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

function isUniqueConstraintError(error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function normalizeIdempotencyKey(value: string) {
    const normalized = value.trim();
    if (!normalized || normalized.length > 200) {
        throw new Error("A valid Idempotency-Key is required");
    }
    return normalized;
}

function normalizeMaxAttempts(value: number | undefined) {
    const attempts = value ?? 3;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
        throw new Error("Import run max attempts must be between 1 and 10");
    }
    return attempts;
}

function parsePlanSnapshot(value: unknown): ImportPlanSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Import plan snapshot is invalid");
    }
    const snapshot = value as Partial<ImportPlanSnapshot>;
    if (
        snapshot.schemaVersion !== IMPORT_PLAN_SCHEMA_VERSION
        || snapshot.engineVersion !== IMPORT_ENGINE_VERSION
        || !Array.isArray(snapshot.items)
        || !Array.isArray(snapshot.requiredPermissions)
        || !snapshot.mutationSummary
        || !snapshot.configurationApproval
    ) {
        throw new Error("Import plan snapshot is invalid");
    }
    const keys = new Set<string>();
    for (const item of snapshot.items) {
        if (
            !item
            || typeof item.itemKey !== "string"
            || !item.itemKey
            || !["CONFIG", "STUDENT", "ALLOCATION", "PAYMENT_CYCLE"].includes(item.kind)
            || keys.has(item.itemKey)
        ) {
            throw new Error("Import plan contains invalid mutation items");
        }
        keys.add(item.itemKey);
    }
    return snapshot as ImportPlanSnapshot;
}

export class ImportRunService {
    static async getDispatchableRun(userId: string, branchId: string, importRunId: string) {
        await AccessPolicy.authorizeAction(userId, branchId, "students", undefined, true);
        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun"
                WHERE "id" = ${importRunId} AND "branchId" = ${branchId}
                FOR UPDATE
            `;
            await AccessPolicy.authorizeAction(userId, branchId, "students", tx, true);
            const run = await tx.importRun.findFirst({
                where: { id: importRunId, branchId },
                include: {
                    session: { select: { id: true, branchId: true, archivedAt: true } },
                    plan: { select: { id: true, importSessionId: true, snapshot: true } },
                },
            });
            if (
                !run
                || !run.session
                || run.session.branchId !== branchId
                || run.session.archivedAt
            ) {
                throw new Error("Import run not found");
            }
            if (run.kind === "COMMIT") {
                if (!run.plan || run.plan.importSessionId !== run.session.id) {
                    throw new Error("Import run not found");
                }
                const snapshot = parsePlanSnapshot(run.plan.snapshot);
                assertImportPlanWithinMutationLimit(snapshot, getImportMaxPlannedMutations());
                await assertImportPlanConfigurationCurrent(tx, branchId, snapshot);
                for (const permission of snapshot.requiredPermissions) {
                    await StaffService.authorize(userId, branchId, permission as StaffAction, tx);
                }
            }
            if (
                TERMINAL_RUN_STATUSES.includes(run.status)
                || run.status === "WAITING_FOR_USER"
                || run.status === "CANCEL_REQUESTED"
            ) {
                throw new Error("Import run is not ready for dispatch");
            }
            if (run.workflowRunId) return run;
            if (!["QUEUED", "RETRYABLE_FAILURE"].includes(run.status)) {
                throw new Error("Import run is not ready for dispatch");
            }
            return run;
        }, { timeout: 30_000 });
    }

    static async getLatestAnalysisRun(userId: string, branchId: string, sessionId: string) {
        await StaffService.authorize(userId, branchId, "students");
        const run = await prisma.importRun.findFirst({
            where: {
                branchId,
                importSessionId: sessionId,
                kind: "ANALYSIS",
            },
            orderBy: { createdAt: "desc" },
        });
        if (!run) throw new Error("Import run not found");
        const { workflowRunId, ...publicRun } = run;
        return {
            ...publicRun,
            workflowAttached: Boolean(workflowRunId),
            dispatchRequired: isImportRunDispatchRequired(run),
        };
    }

    static async confirmPdfExtraction(userId: string, branchId: string, sessionId: string) {
        await AccessPolicy.authorizeAction(userId, branchId, "students", undefined, true);
        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportSession"
                WHERE "id" = ${sessionId} AND "branchId" = ${branchId}
                FOR UPDATE
            `;
            const session = await tx.importSession.findFirst({
                where: { id: sessionId, branchId, sourceType: "PDF", engineVersion: IMPORT_ENGINE_VERSION },
                select: { id: true, sourceConfiguration: true, archivedAt: true },
            });
            if (!session || session.archivedAt) throw new Error("Import session not found");
            await AccessPolicy.authorizeAction(userId, branchId, "students", tx, true);
            const run = await tx.importRun.findFirst({
                where: {
                    importSessionId: session.id,
                    branchId,
                    kind: "ANALYSIS",
                },
                orderBy: { createdAt: "desc" },
            });
            if (!run) throw new Error("Import run not found");
            if (run.status !== "WAITING_FOR_USER") return run;
            const sourceConfiguration = session.sourceConfiguration
                && typeof session.sourceConfiguration === "object"
                && !Array.isArray(session.sourceConfiguration)
                ? session.sourceConfiguration as Record<string, unknown>
                : {};
            await tx.importSession.update({
                where: { id: session.id },
                data: {
                    sourceConfiguration: asJson({ ...sourceConfiguration, pdfConfirmed: true }),
                    status: "UPLOADED",
                    purgeAfter: importStagingPurgeAfter(),
                },
            });
            return tx.importRun.update({
                where: { id: run.id },
                data: { status: "QUEUED", error: Prisma.DbNull },
            });
        });
    }

    static async createOrGetRun(input: CreateImportRunInput) {
        await AccessPolicy.authorizeAction(input.userId, input.branchId, "students", undefined, true);
        const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
        const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
        if (!Number.isInteger(input.targetRevision) || input.targetRevision < 0) {
            throw new Error("Import run target revision is invalid");
        }

        const requestHash = createImportRequestHash({
            kind: input.kind,
            branchId: input.branchId,
            sessionId: input.sessionId,
            importPlanId: input.importPlanId ?? null,
            confirmedPlanVersion: input.confirmedPlanVersion ?? null,
            targetRevision: input.targetRevision,
        });
        const now = new Date();

        try {
            return await prisma.$transaction(async tx => {
                await tx.$queryRaw<Array<{ id: string }>>`
                    SELECT "id" FROM "ImportSession"
                    WHERE "id" = ${input.sessionId} AND "branchId" = ${input.branchId}
                    FOR UPDATE
                `;
                const session = await tx.importSession.findFirst({
                    where: { id: input.sessionId, branchId: input.branchId },
                    select: {
                        id: true,
                        branchId: true,
                        engineVersion: true,
                        goal: true,
                        draftRevision: true,
                        activeEvaluationRevision: true,
                        archivedAt: true,
                    },
                });
                if (!session) throw new Error("Import session not found");
                await AccessPolicy.authorizeAction(input.userId, input.branchId, "students", tx, true);
                if (session.archivedAt) throw new Error("Import session is archived");
                if (session.engineVersion !== IMPORT_ENGINE_VERSION || !session.goal) {
                    throw new Error("Import session does not use the V2 engine");
                }
                if (session.draftRevision !== input.targetRevision) {
                    throw new ImportRevisionConflictError();
                }

                const duplicateKey = await tx.importRun.findUnique({ where: { idempotencyKey } });
                if (duplicateKey) {
                    if (duplicateKey.requestHash !== requestHash) {
                        throw new ImportIdempotencyConflictError();
                    }
                    return duplicateKey;
                }

                const duplicateRequest = await tx.importRun.findFirst({
                    where: {
                        importSessionId: session.id,
                        requestHash,
                    },
                    orderBy: { createdAt: "desc" },
                });
                if (duplicateRequest) return duplicateRequest;

                let plan: Awaited<ReturnType<typeof tx.importPlan.findFirst>> = null;
                let snapshot: ImportPlanSnapshot | null = null;
                if (input.kind === "COMMIT") {
                    if (!input.importPlanId || !input.confirmedPlanVersion) {
                        throw new Error("A confirmed import plan is required");
                    }
                    if (session.activeEvaluationRevision !== input.targetRevision) {
                        throw new ImportRevisionConflictError();
                    }
                    plan = await tx.importPlan.findFirst({
                        where: {
                            id: input.importPlanId,
                            importSessionId: session.id,
                            revision: input.targetRevision,
                        },
                    });
                    if (!plan || plan.planVersion !== input.confirmedPlanVersion) {
                        throw new Error("Confirmed import plan does not match the published revision");
                    }
                    if (!plan.canRun) throw new Error("Import plan has blocking checks");
                    snapshot = parsePlanSnapshot(plan.snapshot);
                    assertImportPlanWithinMutationLimit(snapshot, getImportMaxPlannedMutations());
                    await assertImportPlanConfigurationCurrent(tx, input.branchId, snapshot);
                    if (
                        snapshot.sessionId !== session.id
                        || snapshot.targetRevision !== input.targetRevision
                        || snapshot.goal !== session.goal
                    ) {
                        throw new Error("Import plan snapshot does not match the session");
                    }
                    for (const permission of snapshot.requiredPermissions) {
                        await StaffService.authorize(input.userId, input.branchId, permission as StaffAction, tx);
                    }
                } else if (input.importPlanId || input.confirmedPlanVersion) {
                    throw new Error("Analysis runs cannot be attached to an import plan");
                }

                const active = await tx.importRun.findFirst({
                    where: {
                        importSessionId: session.id,
                        status: { in: ACTIVE_RUN_STATUSES },
                    },
                    orderBy: { createdAt: "desc" },
                });
                if (active) {
                    if (active.requestHash === requestHash) return active;
                    const supersedesOlderAnalysis = (
                        input.kind === "ANALYSIS"
                        && active.kind === "ANALYSIS"
                        && active.targetRevision < input.targetRevision
                    );
                    const supersedesRetryableCommit = (
                        input.kind === "COMMIT"
                        && active.kind === "COMMIT"
                        && active.status === "RETRYABLE_FAILURE"
                        && active.targetRevision < input.targetRevision
                    );
                    if (supersedesOlderAnalysis || supersedesRetryableCommit) {
                        await tx.importRunItem.updateMany({
                            where: {
                                importRunId: active.id,
                                status: { in: ["QUEUED", "RUNNING"] },
                            },
                            data: {
                                status: "CANCELLED",
                                payload: Prisma.DbNull,
                                leaseToken: null,
                                leaseOwner: null,
                                leaseExpiresAt: null,
                                finishedAt: new Date(),
                            },
                        });
                        await tx.importRun.update({
                            where: { id: active.id },
                            data: {
                                status: "SUPERSEDED",
                                finishedAt: new Date(),
                            },
                        });
                    } else {
                        throw new Error("Another import run is already active for this session");
                    }
                }

                const items = snapshot?.items ?? [];
                const run = await tx.importRun.create({
                    data: {
                        branchId: session.branchId,
                        importSessionId: session.id,
                        importPlanId: plan?.id ?? null,
                        targetRevision: input.targetRevision,
                        requestedByUserId: input.userId,
                        idempotencyKey,
                        requestHash,
                        kind: input.kind,
                        maxAttempts,
                        totalItems: items.length,
                    },
                });
                if (items.length > 0) {
                    await tx.importRunItem.createMany({
                        data: items.map((item, ordinal) => ({
                            importRunId: run.id,
                            branchId: run.branchId,
                            importRowId: item.rowId ?? null,
                            evaluationId: item.evaluationId ?? null,
                            ordinal,
                            itemKey: item.itemKey,
                            kind: item.kind,
                            idempotencyKey: `${run.id}:${item.itemKey}`,
                            requestHash: createImportMutationRequestHash(item),
                            payload: item.payload == null ? undefined : asJson(item.payload),
                        })),
                    });
                }
                await tx.importSession.update({
                    where: { id: session.id },
                    data: {
                        ...(input.kind === "COMMIT" ? { status: "COMMITTING" as const } : {}),
                        purgeAfter: importStagingPurgeAfter(now),
                    },
                });
                return run;
            });
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            const existing = await prisma.importRun.findUnique({ where: { idempotencyKey } });
            if (!existing || existing.requestHash !== requestHash) {
                throw new ImportIdempotencyConflictError();
            }
            return existing;
        }
    }

    static async attachWorkflowRun(input: AttachImportWorkflowRunInput) {
        const workflowRunId = input.workflowRunId.trim();
        if (!workflowRunId || workflowRunId.length > 200) {
            throw new Error("Workflow run id is invalid");
        }
        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun" WHERE "id" = ${input.importRunId} FOR UPDATE
            `;
            const run = await tx.importRun.findUnique({ where: { id: input.importRunId } });
            if (!run) throw new Error("Import run not found");
            if (run.workflowRunId === workflowRunId) return run;
            // Concurrent idempotent HTTP requests can both enqueue before the
            // first attachment is visible. The ledger keeps the first owner;
            // the duplicate Workflow self-detects this and exits harmlessly.
            if (run.workflowRunId) return run;
            return tx.importRun.update({
                where: { id: run.id },
                data: { workflowRunId },
            });
        });
    }

    static async releaseWorkflowRunForRedispatch(input: {
        importRunId: string;
        expectedWorkflowRunId: string;
    }) {
        const expectedWorkflowRunId = input.expectedWorkflowRunId.trim();
        if (!expectedWorkflowRunId || expectedWorkflowRunId.length > 200) {
            throw new Error("Workflow run id is invalid");
        }
        const now = new Date();
        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun" WHERE "id" = ${input.importRunId} FOR UPDATE
            `;
            const run = await tx.importRun.findUnique({ where: { id: input.importRunId } });
            if (!run) throw new Error("Import run not found");
            if (
                run.workflowRunId !== expectedWorkflowRunId
                || TERMINAL_RUN_STATUSES.includes(run.status)
                || run.status === "CANCEL_REQUESTED"
            ) {
                return run;
            }
            return tx.importRun.update({
                where: { id: run.id },
                data: {
                    workflowRunId: null,
                    status: "RETRYABLE_FAILURE",
                    lastHeartbeatAt: now,
                    error: asJson({
                        code: "IMPORT_WORKFLOW_PROVIDER_TERMINATED",
                        message: "Background processing will resume on a replacement workflow run.",
                        retryable: true,
                    }),
                },
            });
        });
    }

    static async getWorkflowDispatchState(importRunId: string) {
        const run = await prisma.importRun.findUnique({
            where: { id: importRunId },
            select: { id: true, kind: true, workflowRunId: true, status: true },
        });
        if (!run) throw new Error("Import run not found");
        return run;
    }

    static async getRun(userId: string, branchId: string, importRunId: string) {
        await StaffService.authorize(userId, branchId, "students");
        const run = await prisma.importRun.findFirst({
            where: { id: importRunId, branchId },
            include: {
                items: {
                    orderBy: { ordinal: "asc" },
                    select: {
                        id: true,
                        ordinal: true,
                        itemKey: true,
                        kind: true,
                        status: true,
                        attemptCount: true,
                        result: true,
                        error: true,
                        startedAt: true,
                        finishedAt: true,
                    },
                },
            },
        });
        if (!run) throw new Error("Import run not found");
        const { workflowRunId, ...publicRun } = run;
        return {
            ...publicRun,
            workflowAttached: Boolean(workflowRunId),
            dispatchRequired: isImportRunDispatchRequired(run),
        };
    }

    static async getRunProgress(userId: string, branchId: string, importRunId: string) {
        await StaffService.authorize(userId, branchId, "students");
        const run = await prisma.importRun.findFirst({
            where: { id: importRunId, branchId },
            select: {
                id: true,
                importSessionId: true,
                importPlanId: true,
                targetRevision: true,
                kind: true,
                status: true,
                totalItems: true,
                completedItems: true,
                succeededItems: true,
                failedItems: true,
                skippedItems: true,
                cancelledItems: true,
                cancelRequestedAt: true,
                startedAt: true,
                finishedAt: true,
                lastHeartbeatAt: true,
                createdAt: true,
                updatedAt: true,
                error: true,
                workflowRunId: true,
            },
        });
        if (!run) throw new Error("Import run not found");
        const { workflowRunId, ...publicRun } = run;
        return {
            ...publicRun,
            workflowAttached: Boolean(workflowRunId),
            dispatchRequired: isImportRunDispatchRequired(run),
        };
    }

    static async getRunErrors(userId: string, branchId: string, importRunId: string) {
        await StaffService.authorize(userId, branchId, "students");
        const run = await prisma.importRun.findFirst({
            where: { id: importRunId, branchId },
            select: { id: true },
        });
        if (!run) throw new Error("Import run not found");
        return prisma.importRunItem.findMany({
            where: {
                importRunId: run.id,
                status: { in: ["FAILED", "CANCELLED", "SKIPPED"] },
            },
            orderBy: { ordinal: "asc" },
            select: {
                ordinal: true,
                itemKey: true,
                kind: true,
                status: true,
                attemptCount: true,
                error: true,
                row: { select: { rowNumber: true } },
            },
        });
    }

    static async requestCancel(userId: string, branchId: string, importRunId: string) {
        await AccessPolicy.authorizeAction(userId, branchId, "students", undefined, true);
        const now = new Date();

        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun"
                WHERE "id" = ${importRunId} AND "branchId" = ${branchId}
                FOR UPDATE
            `;
            await AccessPolicy.authorizeAction(userId, branchId, "students", tx, true);
            const run = await tx.importRun.findFirst({ where: { id: importRunId, branchId } });
            if (!run) throw new Error("Import run not found");
            if (![...ACTIVE_RUN_STATUSES].includes(run.status)) return run;

            await tx.importRunItem.updateMany({
                where: { importRunId: run.id, status: "QUEUED" },
                data: {
                    status: "CANCELLED",
                    payload: Prisma.DbNull,
                    finishedAt: now,
                },
            });
            const [runningItems, succeededItems, failedItems, skippedItems, cancelledItems] = await Promise.all([
                tx.importRunItem.count({ where: { importRunId: run.id, status: "RUNNING" } }),
                tx.importRunItem.count({ where: { importRunId: run.id, status: "SUCCEEDED" } }),
                tx.importRunItem.count({ where: { importRunId: run.id, status: "FAILED" } }),
                tx.importRunItem.count({ where: { importRunId: run.id, status: "SKIPPED" } }),
                tx.importRunItem.count({ where: { importRunId: run.id, status: "CANCELLED" } }),
            ]);
            const completedItems = succeededItems + failedItems + skippedItems + cancelledItems;
            const updated = await tx.importRun.update({
                where: { id: run.id },
                data: {
                    status: runningItems > 0 ? "CANCEL_REQUESTED" : "CANCELLED",
                    cancelRequestedAt: run.cancelRequestedAt ?? now,
                    cancelRequestedByUserId: userId,
                    completedItems,
                    succeededItems,
                    failedItems,
                    skippedItems,
                    cancelledItems,
                    ...(runningItems > 0 ? {} : { finishedAt: now }),
                },
            });
            await syncImportSessionRunLifecycle(tx, updated, now);
            return updated;
        }, { timeout: 30_000 });
    }
}
