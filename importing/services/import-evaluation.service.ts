import { AccessPolicy } from "@/services/accessPolicy.service";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import {
    IMPORT_ENGINE_VERSION,
    type PublishImportEvaluationsInput,
} from "../contracts/import-v2.contract";
import { ImportRevisionConflictError } from "../utils/import-errors";
import { importStagingPurgeAfter } from "../utils/import-retention";

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function assertValidRevision(revision: number) {
    if (!Number.isInteger(revision) || revision < 0) {
        throw new Error("Import evaluation revision is invalid");
    }
}

export class ImportEvaluationService {
    static async publishRevision(input: PublishImportEvaluationsInput) {
        await AccessPolicy.authorizeAction(input.userId, input.branchId, "students", undefined, true);
        assertValidRevision(input.targetRevision);

        const suppliedRows = new Map(input.evaluations.map(evaluation => [evaluation.rowId, evaluation]));
        if (suppliedRows.size !== input.evaluations.length) {
            throw new Error("Import evaluations contain duplicate rows");
        }

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
                    draftRevision: true,
                    activeEvaluationRevision: true,
                    archivedAt: true,
                    rows: {
                        orderBy: { rowNumber: "asc" },
                        select: { id: true, rowNumber: true },
                    },
                },
            });
            if (!session) throw new Error("Import session not found");
            if (session.archivedAt) throw new Error("Import session is archived");
            if (session.engineVersion !== IMPORT_ENGINE_VERSION) {
                throw new Error("Import session does not use the V2 engine");
            }
            if (session.draftRevision !== input.targetRevision) {
                throw new ImportRevisionConflictError();
            }

            if (session.activeEvaluationRevision === input.targetRevision) {
                const publishedCount = await tx.importRowEvaluation.count({
                    where: {
                        revision: input.targetRevision,
                        importRowId: { in: session.rows.map(row => row.id) },
                    },
                });
                if (publishedCount !== session.rows.length) {
                    throw new Error("Published import evaluation revision is incomplete");
                }
                return {
                    sessionId: session.id,
                    revision: input.targetRevision,
                    evaluationCount: publishedCount,
                    alreadyPublished: true,
                };
            }

            if (suppliedRows.size !== session.rows.length) {
                throw new Error("Import evaluations do not cover every staged row");
            }
            for (const row of session.rows) {
                const evaluation = suppliedRows.get(row.id);
                if (!evaluation || evaluation.rowNumber !== row.rowNumber) {
                    throw new Error("Import evaluations do not match the staged rows");
                }
            }

            await tx.importRowEvaluation.deleteMany({
                where: {
                    revision: input.targetRevision,
                    importRowId: { in: session.rows.map(row => row.id) },
                },
            });
            await tx.importRowEvaluation.createMany({
                data: session.rows.map(row => {
                    const evaluation = suppliedRows.get(row.id)!;
                    return {
                        importRowId: row.id,
                        branchId: input.branchId,
                        revision: input.targetRevision,
                        engineVersion: IMPORT_ENGINE_VERSION,
                        status: evaluation.status,
                        mappedData: evaluation.mappedData === undefined ? undefined : asJson(evaluation.mappedData),
                        normalizedData: evaluation.normalizedData === undefined ? undefined : asJson(evaluation.normalizedData),
                        issues: asJson(evaluation.issues ?? []),
                        warnings: asJson(evaluation.warnings ?? []),
                        confidence: evaluation.confidence ?? null,
                        skipped: Boolean(evaluation.skipped),
                    };
                }),
            });

            const published = await tx.importSession.updateMany({
                where: {
                    id: session.id,
                    branchId: input.branchId,
                    draftRevision: input.targetRevision,
                },
                data: {
                    activeEvaluationRevision: input.targetRevision,
                    purgeAfter: importStagingPurgeAfter(),
                },
            });
            if (published.count !== 1) {
                throw new ImportRevisionConflictError();
            }

            return {
                sessionId: session.id,
                revision: input.targetRevision,
                evaluationCount: session.rows.length,
                alreadyPublished: false,
            };
        });
    }
}
