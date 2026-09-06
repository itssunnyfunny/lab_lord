import { AccessPolicy } from "@/services/accessPolicy.service";
import { prisma } from "@/lib/prisma";
import { ImportSessionService } from "./import-session.service";
import { inferConfirmedPaymentMapping } from "@/importing/utils/payment-mapping-inference";
import type { ImportAIQuestion, ImportMappingState, ImportOptions } from "@/importing/contracts/import-session.contract";
import type { Prisma } from "@/app/generated/prisma/client";
import { applyImportGoalMappingPolicy, applyImportGoalPolicy } from "@/importing/utils/import-goal-policy";
import { importStagingPurgeAfter } from "@/importing/utils/import-retention";
import { ImportRevisionConflictError, ImportValidationError } from "@/importing/utils/import-errors";

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

const paymentCycleAnswers = ["USE_JOINED_AT_ANNIVERSARY"] as const;
const paymentActionAnswers = ["GENERATE_DUE", "IMPORT_PAID_UNPAID"] as const;
const paymentHistoryAnswers = [
    "START_CURRENT_JOINED_CYCLE",
    "FROM_JOINED_MARK_PAID",
    "FROM_JOINED_MARK_DUE",
    "FROM_JOINED_PAID_THROUGH_PREVIOUS",
] as const;

function answerValue(answer: unknown) {
    return typeof answer === "string"
        ? answer
        : answer && typeof answer === "object" && "value" in answer
            ? String((answer as { value: unknown }).value)
            : "";
}

function sameQuestion(stored: ImportAIQuestion, question: { field: string | null; question: string }) {
    return (stored.field ?? null) === question.field && stored.question === question.question;
}

function answerToOptions(question: { field: string | null }, answer: unknown): Partial<ImportOptions> {
    const value = answerValue(answer);

    if (value === "SKIP_PAYMENTS") {
        return { paymentCycle: "SKIP_PAYMENTS", paymentAction: "SKIP_PAYMENTS" };
    }
    if (paymentActionAnswers.includes(value as typeof paymentActionAnswers[number])) {
        return {
            paymentAction: value as ImportOptions["paymentAction"],
            paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
        };
    }
    if (paymentCycleAnswers.includes(value as typeof paymentCycleAnswers[number])) {
        return { paymentCycle: value as ImportOptions["paymentCycle"] };
    }
    if (paymentHistoryAnswers.includes(value as typeof paymentHistoryAnswers[number])) {
        return {
            paymentHistoryMode: value as ImportOptions["paymentHistoryMode"],
            paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
        };
    }
    if (question.field === "student.joinedAt") {
        return { defaultJoinedAt: value === "USE_TODAY" ? new Date().toISOString().slice(0, 10) : value };
    }
    if (value === "SKIP_ALLOCATIONS") {
        return {
            createUnknownSeats: false,
            createUnknownShifts: false,
            createUnknownMultiShifts: false,
            skipUnknownSeatAllocations: true,
            skipUnknownShiftAllocations: true,
            skipUnknownMultiShiftAllocations: true,
            skipMissingShiftAllocations: true,
            skipConflictingAllocations: true,
        };
    }
    if (question.field === "seat.label" && value === "YES_CREATE_SEATS") return { createUnknownSeats: true };
    if (question.field === "seat.label" && ["SKIP_UNKNOWN_SEAT_ALLOCATION", "NO_SKIP_ALLOCATIONS"].includes(value)) return { skipUnknownSeatAllocations: true };
    if (question.field === "seat.label" && value) return { defaultSeatLabel: value };
    if (question.field === "allocation.shiftName" && value === "CREATE_SHIFT") return { createUnknownShifts: true };
    if (question.field === "allocation.shiftName" && value === "SKIP_MISSING_SHIFT_ALLOCATION") return { skipMissingShiftAllocations: true };
    if (question.field === "allocation.shiftName" && ["SKIP_UNKNOWN_SHIFT_ALLOCATION", "SKIP_ALLOCATIONS"].includes(value)) return { skipUnknownShiftAllocations: true };
    if (question.field === "allocation.shiftName" && value && !["MAP_TO_EXISTING_SHIFT"].includes(value)) {
        return { defaultShiftName: value };
    }
    if (question.field === "allocation.multiShiftName" && value === "CREATE_MULTI_SHIFT") return { createUnknownMultiShifts: true };
    if (question.field === "allocation.multiShiftName" && ["SKIP_UNKNOWN_MULTI_SHIFT_ALLOCATION", "SKIP_ALLOCATIONS"].includes(value)) return { skipUnknownMultiShiftAllocations: true };
    if (question.field === "allocation.multiShiftName" && value && !["MAP_TO_EXISTING_MULTI_SHIFT"].includes(value)) {
        return { defaultMultiShiftName: value };
    }
    return {};
}

export class ImportQuestionService {
    static async listQuestions(userId: string, branchId: string, sessionId: string) {
        return (await ImportSessionService.getSessionDetail(userId, branchId, sessionId)).questions;
    }

    static async answerQuestion(
        userId: string,
        branchId: string,
        sessionId: string,
        input: {
            expectedRevision: number;
            questionId: string;
            answer: unknown;
            applyToAffectedRows?: boolean;
        }
    ) {
        await AccessPolicy.authorizeAction(userId, branchId, "students", undefined, true);
        if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
            throw new ImportValidationError("Expected import revision must be a non-negative integer");
        }
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: {
                questions: { where: { id: input.questionId, status: "OPEN" } },
                rows: { select: { id: true, status: true, rawData: true } },
            },
        });
        if (!session) throw new Error("Import session not found");
        if (session.archivedAt) throw new Error("Import session is archived");
        if (
            (session.engineVersion === 1 && ["COMMITTING", "COMMITTED", "PARTIAL", "FAILED", "CANCELLED"].includes(session.status))
            || ["COMMITTING", "COMMITTED", "CANCELLED"].includes(session.status)
        ) {
            throw new Error("Import session is not editable");
        }
        if (session.draftRevision !== input.expectedRevision) throw new ImportRevisionConflictError();
        const question = session.questions[0];
        if (!question) throw new Error("Import question not found");
        if (question.rowId && session.rows.some(row => row.id === question.rowId && row.status === "IMPORTED")) {
            throw new Error("Imported rows are immutable; answer a question for an unresolved row instead");
        }

        const columns = Object.keys((session.rows[0]?.rawData ?? {}) as Record<string, unknown>);
        const current = session.mapping as ImportMappingState | null;
        const answeredOptions = answerToOptions(question, input.answer);
        const nextImportOptions = applyImportGoalPolicy(session.goal, {
            ...(current?.importOptions ?? {}),
            ...answeredOptions,
        });
        const nextMapping = applyImportGoalMappingPolicy(session.goal, {
            entityTypesDetected: current?.entityTypesDetected ?? ["STUDENT"],
            columnMappings: current?.columnMappings ?? [],
            questions: (current?.questions ?? []).filter(storedQuestion => !sameQuestion(storedQuestion, question)),
            warnings: current?.warnings ?? [],
            importOptions: nextImportOptions,
            analysis: current?.analysis,
            usedFallback: current?.usedFallback,
        });

        if (nextMapping.columnMappings.length === 0 && columns.length > 0) {
            const { buildFallbackMappings } = await import("@/importing/utils/column-normalizer");
            nextMapping.columnMappings = buildFallbackMappings(columns);
        }

        if (
            nextMapping.importOptions?.paymentAction === "IMPORT_PAID_UNPAID" &&
            !nextMapping.importOptions.paymentMapping?.confirmed
        ) {
            const inferredPaymentMapping = inferConfirmedPaymentMapping({
                current: nextMapping.importOptions.paymentMapping,
                columnMappings: nextMapping.columnMappings,
                rows: session.rows,
            });
            if (inferredPaymentMapping) {
                nextMapping.importOptions = {
                    ...nextMapping.importOptions,
                    paymentMapping: inferredPaymentMapping,
                };
            }
        }

        await prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportSession"
                WHERE "id" = ${sessionId} AND "branchId" = ${branchId}
                FOR UPDATE
            `;
            const current = await tx.importSession.findFirst({
                where: { id: sessionId, branchId },
                select: {
                    engineVersion: true,
                    status: true,
                    draftRevision: true,
                    archivedAt: true,
                },
            });
            if (!current) throw new Error("Import session not found");
            if (current.archivedAt) throw new Error("Import session is archived");
            await AccessPolicy.authorizeAction(userId, branchId, "students", tx, true);
            if (
                (current.engineVersion === 1 && ["COMMITTING", "COMMITTED", "PARTIAL", "FAILED", "CANCELLED"].includes(current.status))
                || ["COMMITTING", "COMMITTED", "CANCELLED"].includes(current.status)
            ) {
                throw new Error("Import session is not editable");
            }
            if (current.draftRevision !== input.expectedRevision) throw new ImportRevisionConflictError();
            const answered = await tx.importQuestion.updateMany({
                where: {
                    id: input.questionId,
                    importSessionId: sessionId,
                    status: "OPEN",
                },
                data: {
                    answer: asJson(input.answer),
                    status: "ANSWERED",
                    answeredAt: new Date(),
                },
            });
            if (answered.count !== 1) throw new ImportRevisionConflictError();
            await tx.importSession.update({
                where: { id: sessionId },
                data: {
                    mapping: asJson(nextMapping),
                    draftRevision: { increment: 1 },
                    purgeAfter: importStagingPurgeAfter(),
                },
            });
        });

        return ImportSessionService.revalidateCurrentDraft(userId, branchId, sessionId);
    }
}
