import { prisma } from "@/lib/prisma";
import { ImportSessionService } from "./import-session.service";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import { inferConfirmedPaymentMapping } from "@/importing/utils/payment-mapping-inference";
import type { ImportAIQuestion, ImportMappingState, ImportOptions } from "@/importing/contracts/import-session.contract";
import type { Prisma } from "@/app/generated/prisma/client";

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

const paymentCycleAnswers = ["CURRENT_MONTH", "PREVIOUS_MONTH", "CUSTOM_PERIOD", "USE_JOINED_AT_ANNIVERSARY"] as const;
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

    if (question.field === "payment.customPeriod" && answer && typeof answer === "object") {
        const customPeriodStart = "customPeriodStart" in answer ? String((answer as { customPeriodStart: unknown }).customPeriodStart) : "";
        const customPeriodEnd = "customPeriodEnd" in answer ? String((answer as { customPeriodEnd: unknown }).customPeriodEnd) : "";
        return {
            paymentCycle: "CUSTOM_PERIOD",
            ...(customPeriodStart ? { customPeriodStart } : {}),
            ...(customPeriodEnd ? { customPeriodEnd } : {}),
        };
    }

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
        return { defaultJoinedAt: value === "USE_TODAY" ? new Date().toISOString() : value };
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
        input: { questionId: string; answer: unknown; applyToAffectedRows?: boolean }
    ) {
        await StaffService.authorize(userId, branchId, "students");
        await EntitlementService.assertBranchWritable(branchId);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: { questions: { where: { id: input.questionId } }, rows: { select: { rawData: true } } },
        });
        if (!session) throw new Error("Import session not found");
        const question = session.questions[0];
        if (!question) throw new Error("Import question not found");

        const columns = Object.keys((session.rows[0]?.rawData ?? {}) as Record<string, unknown>);
        const current = session.mapping as ImportMappingState | null;
        const answeredOptions = answerToOptions(question, input.answer);
        const nextImportOptions = {
            ...(current?.importOptions ?? {}),
            ...answeredOptions,
        };
        const nextMapping: ImportMappingState = {
            entityTypesDetected: current?.entityTypesDetected ?? ["STUDENT"],
            columnMappings: current?.columnMappings ?? [],
            questions: (current?.questions ?? []).filter(storedQuestion => !sameQuestion(storedQuestion, question)),
            warnings: current?.warnings ?? [],
            importOptions: nextImportOptions,
            analysis: current?.analysis,
            usedFallback: current?.usedFallback,
        };

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

        await prisma.importQuestion.update({
            where: { id: input.questionId },
            data: {
                answer: asJson(input.answer),
                status: "ANSWERED",
                answeredAt: new Date(),
            },
        });

        await prisma.importSession.update({
            where: { id: sessionId },
            data: { mapping: asJson(nextMapping) },
        });

        return ImportSessionService.revalidateSession(userId, branchId, sessionId);
    }
}
