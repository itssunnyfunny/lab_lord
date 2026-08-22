import { prisma } from "@/lib/prisma";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import type { Prisma } from "@/app/generated/prisma/client";
import { STAFF_ACTIONS, type StaffAction } from "@/types";
import { getImportMaxPlannedMutations } from "@/lib/importFeature";
import type { ImportIssue, ImportMappingState, ImportNormalizedRow, ImportSessionSummary } from "../contracts/import-session.contract";
import {
    IMPORT_ENGINE_VERSION,
    type CompileImportPlanInput,
    type ImportPlanPaymentCycleDetail,
    type ImportPlanSnapshot,
} from "../contracts/import-v2.contract";
import {
    assertImportPlanWithinMutationLimit,
    compileImportConfigurationCandidateItems,
    compileImportPlanSnapshot,
    exactImportPaymentCycleFromPayload,
} from "../utils/import-plan-compiler";
import { ImportRevisionConflictError } from "../utils/import-errors";
import { importStagingPurgeAfter } from "../utils/import-retention";
import {
    assertImportPlanConfigurationCurrent,
    reusableSucceededConfigurationItemKeys,
} from "./import-plan-configuration.service";

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function asMapping(value: unknown): ImportMappingState {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Import mapping is not ready");
    }
    const mapping = value as Partial<ImportMappingState>;
    if (!Array.isArray(mapping.columnMappings) || !Array.isArray(mapping.entityTypesDetected)) {
        throw new Error("Import mapping is not ready");
    }
    return mapping as ImportMappingState;
}

function resultEntityIds(value: Prisma.JsonValue | null) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entityIds = (value as { entityIds?: unknown }).entityIds;
    return Array.isArray(entityIds)
        ? entityIds.filter((id): id is string => typeof id === "string" && Boolean(id))
        : [];
}

const STAFF_ACTION_SET = new Set<string>(STAFF_ACTIONS);
export const DEFAULT_IMPORT_PAYMENT_DETAIL_PAGE_SIZE = 50;
export const MAX_IMPORT_PAYMENT_DETAIL_PAGE_SIZE = 100;

function paymentDetailPageSize(value: number | undefined) {
    const limit = value ?? DEFAULT_IMPORT_PAYMENT_DETAIL_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_IMPORT_PAYMENT_DETAIL_PAGE_SIZE) {
        throw new Error("Import payment detail page size is invalid");
    }
    return limit;
}

function requiredPermissionsFromSnapshot(value: unknown): StaffAction[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Import plan snapshot is invalid");
    }
    const permissions = (value as { requiredPermissions?: unknown }).requiredPermissions;
    if (
        !Array.isArray(permissions)
        || permissions.length === 0
        || permissions.some(permission => typeof permission !== "string" || !STAFF_ACTION_SET.has(permission))
    ) {
        throw new Error("Import plan snapshot is invalid");
    }
    return [...new Set(permissions)] as StaffAction[];
}

async function authorizePlanPermissions(
    userId: string,
    branchId: string,
    snapshot: unknown,
    tx?: Prisma.TransactionClient
) {
    for (const permission of requiredPermissionsFromSnapshot(snapshot)) {
        await StaffService.authorize(userId, branchId, permission, tx);
    }
}

export class ImportPlanService {
    static async getPaymentDetails(
        userId: string,
        branchId: string,
        sessionId: string,
        planId: string,
        options: { cursor?: string; limit?: number } = {}
    ) {
        await StaffService.authorize(userId, branchId, "students");
        const limit = paymentDetailPageSize(options.limit);
        const cursor = options.cursor?.trim();
        if (cursor && cursor.length > 500) throw new Error("Import payment detail cursor is invalid");
        const plan = await prisma.importPlan.findFirst({
            where: {
                id: planId,
                importSessionId: sessionId,
                session: { branchId, archivedAt: null },
            },
            select: { id: true, revision: true, planVersion: true, snapshot: true },
        });
        if (!plan) throw new Error("Import plan not found");
        await authorizePlanPermissions(userId, branchId, plan.snapshot);
        if (!plan.snapshot || typeof plan.snapshot !== "object" || Array.isArray(plan.snapshot)) {
            throw new Error("Import plan snapshot is invalid");
        }
        const snapshot = plan.snapshot as unknown as Partial<ImportPlanSnapshot>;
        if (
            !Array.isArray(snapshot.items)
            || !snapshot.mutationSummary
            || !Array.isArray(snapshot.mutationSummary.paymentBreakdown)
        ) {
            throw new Error("Import plan snapshot is invalid");
        }
        const paymentItems = snapshot.items.filter(item => item.kind === "PAYMENT_CYCLE");
        const paymentStudentByRowId = new Map(
            snapshot.mutationSummary.paymentBreakdown.map(student => [student.rowId, student])
        );
        const startIndex = cursor
            ? paymentItems.findIndex(item => item.itemKey === cursor) + 1
            : 0;
        if (cursor && startIndex === 0) throw new Error("Import payment detail cursor is invalid");
        const pageItems = paymentItems.slice(startIndex, startIndex + limit + 1);
        const hasMore = pageItems.length > limit;
        const returnedItems = hasMore ? pageItems.slice(0, limit) : pageItems;
        const cycles: ImportPlanPaymentCycleDetail[] = returnedItems.map(item => {
            if (!item.rowId || !item.payload) throw new Error("Import plan payment detail is invalid");
            const student = paymentStudentByRowId.get(item.rowId);
            if (!student) throw new Error("Import plan payment detail is invalid");
            return {
                itemKey: item.itemKey,
                rowId: item.rowId,
                rowNumber: student.rowNumber,
                studentName: student.studentName,
                ...exactImportPaymentCycleFromPayload(item.payload),
            };
        });
        const nextCursor = hasMore && returnedItems.length > 0
            ? returnedItems[returnedItems.length - 1].itemKey
            : null;
        return {
            planId: plan.id,
            revision: plan.revision,
            planVersion: plan.planVersion,
            totalCycles: paymentItems.length,
            affectedStudents: new Set(paymentItems.map(item => item.rowId).filter(Boolean)).size,
            cycles,
            page: {
                limit,
                cursor: cursor ?? null,
                nextCursor,
                hasMore,
                returnedCycles: cycles.length,
            },
        };
    }

    static async getPlanForCommit(userId: string, branchId: string, sessionId: string, planId: string) {
        await StaffService.authorize(userId, branchId, "students");
        await EntitlementService.assertBranchWritable(branchId);
        const plan = await prisma.importPlan.findFirst({
            where: {
                id: planId,
                importSessionId: sessionId,
                canRun: true,
                session: {
                    branchId,
                    archivedAt: null,
                },
            },
            select: {
                id: true,
                revision: true,
                planVersion: true,
                canRun: true,
                importSessionId: true,
                snapshot: true,
                session: {
                    select: { draftRevision: true, activeEvaluationRevision: true },
                },
            },
        });
        if (
            !plan
            || plan.session.draftRevision !== plan.revision
            || plan.session.activeEvaluationRevision !== plan.revision
        ) {
            throw new Error("Import plan not found");
        }
        assertImportPlanWithinMutationLimit(plan.snapshot, getImportMaxPlannedMutations());
        const { snapshot, ...confirmedPlan } = plan;
        await authorizePlanPermissions(userId, branchId, snapshot);
        return confirmedPlan;
    }

    static async compilePlan(input: CompileImportPlanInput) {
        await StaffService.authorize(input.userId, input.branchId, "students");
        await EntitlementService.assertBranchWritable(input.branchId);
        if (!Number.isInteger(input.targetRevision) || input.targetRevision < 0) {
            throw new Error("Import plan revision is invalid");
        }
        const maxPlannedMutations = getImportMaxPlannedMutations();

        return prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportSession"
                WHERE "id" = ${input.sessionId} AND "branchId" = ${input.branchId}
                FOR UPDATE
            `;
            const session = await tx.importSession.findFirst({
                where: { id: input.sessionId, branchId: input.branchId },
                select: {
                    id: true,
                    engineVersion: true,
                    goal: true,
                    mapping: true,
                    summary: true,
                    draftRevision: true,
                    activeEvaluationRevision: true,
                    archivedAt: true,
                    questions: {
                        where: { status: "OPEN" },
                        select: { id: true },
                    },
                    rows: {
                        orderBy: { rowNumber: "asc" },
                        select: {
                            id: true,
                            rowNumber: true,
                            evaluations: {
                                where: { revision: input.targetRevision },
                                select: {
                                    id: true,
                                    importRowId: true,
                                    status: true,
                                    skipped: true,
                                    normalizedData: true,
                                    warnings: true,
                                },
                            },
                        },
                    },
                },
            });
            if (!session) throw new Error("Import session not found");
            if (session.archivedAt) throw new Error("Import session is archived");
            if (session.engineVersion !== IMPORT_ENGINE_VERSION || !session.goal) {
                throw new Error("Import session does not use the V2 engine");
            }
            await StaffService.authorize(input.userId, input.branchId, "students", tx);
            await EntitlementService.assertBranchWritable(input.branchId, tx);
            if (
                session.draftRevision !== input.targetRevision
                || session.activeEvaluationRevision !== input.targetRevision
            ) {
                throw new ImportRevisionConflictError();
            }
            await tx.importSession.update({
                where: { id: session.id },
                data: { purgeAfter: importStagingPurgeAfter() },
            });

            const existing = await tx.importPlan.findUnique({
                where: {
                    importSessionId_revision_readinessPolicy: {
                        importSessionId: session.id,
                        revision: input.targetRevision,
                        readinessPolicy: input.readinessPolicy,
                    },
                },
            });
            if (existing) {
                assertImportPlanWithinMutationLimit(existing.snapshot, maxPlannedMutations);
                await assertImportPlanConfigurationCurrent(
                    tx,
                    input.branchId,
                    existing.snapshot as unknown as Parameters<typeof assertImportPlanConfigurationCurrent>[2],
                    { allowUnapprovedConfiguration: true }
                );
                await authorizePlanPermissions(input.userId, input.branchId, existing.snapshot, tx);
                return existing;
            }

            const previouslySucceededItems = await tx.importRunItem.findMany({
                where: {
                    status: "SUCCEEDED",
                    run: {
                        importSessionId: session.id,
                        kind: "COMMIT",
                    },
                },
                orderBy: { createdAt: "desc" },
                select: {
                    itemKey: true,
                    kind: true,
                    importRowId: true,
                    requestHash: true,
                    result: true,
                },
            });

            const previouslySucceededMutations = previouslySucceededItems.map(item => ({
                itemKey: item.itemKey,
                kind: item.kind,
                rowId: item.importRowId,
                entityIds: resultEntityIds(item.result),
                requestHash: item.requestHash,
            }));
            const compileInput = {
                sessionId: session.id,
                targetRevision: input.targetRevision,
                goal: session.goal,
                readinessPolicy: input.readinessPolicy,
                mapping: asMapping(session.mapping),
                summary: session.summary as ImportSessionSummary | null,
                hasOpenQuestions: session.questions.length > 0,
                expectedRowCount: session.rows.length,
                evaluations: session.rows.flatMap(row => row.evaluations.map(evaluation => ({
                    id: evaluation.id,
                    rowId: evaluation.importRowId,
                    rowNumber: row.rowNumber,
                    status: evaluation.status,
                    skipped: evaluation.skipped,
                    normalizedData: evaluation.normalizedData as ImportNormalizedRow | null,
                    warnings: Array.isArray(evaluation.warnings) ? evaluation.warnings as ImportIssue[] : [],
                }))),
                asOf: new Date(),
                maxPlannedMutations,
            } satisfies Parameters<typeof compileImportPlanSnapshot>[0];
            const configurationCandidates = compileImportConfigurationCandidateItems(compileInput);
            const reusableConfigurationKeys = new Set(await reusableSucceededConfigurationItemKeys(
                tx,
                input.branchId,
                { items: configurationCandidates },
                previouslySucceededMutations
            ));
            const compiled = compileImportPlanSnapshot({
                ...compileInput,
                previouslySucceededItems: previouslySucceededMutations.filter(item =>
                    item.kind !== "CONFIG" || reusableConfigurationKeys.has(item.itemKey)
                ),
            });

            await assertImportPlanConfigurationCurrent(
                tx,
                input.branchId,
                compiled.snapshot,
                { allowUnapprovedConfiguration: true }
            );

            await authorizePlanPermissions(input.userId, input.branchId, compiled.snapshot, tx);

            return tx.importPlan.create({
                data: {
                    importSessionId: session.id,
                    revision: input.targetRevision,
                    engineVersion: IMPORT_ENGINE_VERSION,
                    goal: session.goal,
                    readinessPolicy: input.readinessPolicy,
                    planVersion: compiled.planVersion,
                    canRun: compiled.canRun,
                    totalRows: compiled.totalRows,
                    readyRows: compiled.readyRows,
                    blockedRows: compiled.blockedRows,
                    warningRows: compiled.warningRows,
                    skippedRows: compiled.skippedRows,
                    snapshot: asJson(compiled.snapshot),
                    checks: asJson(compiled.checks),
                    summary: asJson(compiled.summary),
                    compiledByUserId: input.userId,
                },
            });
        });
    }
}
