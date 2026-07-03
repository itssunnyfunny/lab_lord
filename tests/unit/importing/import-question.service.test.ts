import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    revalidateSession: vi.fn(),
    getSessionDetail: vi.fn(),
    prisma: {
        importSession: {
            findFirst: vi.fn(),
            update: vi.fn(),
        },
        importQuestion: {
            update: vi.fn(),
        },
    },
}));

vi.mock("@/services/staff.service", () => ({
    StaffService: {
        authorize: mocks.authorize,
    },
}));

vi.mock("@/importing/services/import-session.service", () => ({
    ImportSessionService: {
        getSessionDetail: mocks.getSessionDetail,
        revalidateSession: mocks.revalidateSession,
    },
}));

vi.mock("@/lib/prisma", () => ({
    prisma: mocks.prisma,
}));

const analysis = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceProfile: {
        rowCount: 1,
        columnCount: 1,
        emptyCellRate: 0,
        columns: [],
        highSignalColumns: ["Name"],
        lowSignalColumns: [],
    },
    attention: [],
    pipeline: [],
    model: "gemini-3.5-flash",
};

describe("ImportQuestionService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(true);
        mocks.prisma.importQuestion.update.mockResolvedValue({});
        mocks.prisma.importSession.update.mockResolvedValue({});
        mocks.revalidateSession.mockResolvedValue({ id: "session_1" });
    });

    it("authorizes before mutating a question answer", async () => {
        mocks.authorize.mockRejectedValueOnce(new Error("Unauthorized"));
        const { ImportQuestionService } = await import("@/importing/services/import-question.service");

        await expect(ImportQuestionService.answerQuestion("user_1", "branch_1", "session_1", {
            questionId: "question_1",
            answer: "CURRENT_MONTH",
        })).rejects.toThrow("Unauthorized");

        expect(mocks.prisma.importSession.findFirst).not.toHaveBeenCalled();
        expect(mocks.prisma.importQuestion.update).not.toHaveBeenCalled();
    });

    it("preserves analysis metadata when applying an answer", async () => {
        mocks.prisma.importSession.findFirst.mockResolvedValueOnce({
            id: "session_1",
            mapping: {
                entityTypesDetected: ["STUDENT"],
                columnMappings: [{ sourceColumn: "Name", targetField: "student.name", confidence: 95 }],
                questions: [],
                warnings: [],
                importOptions: {},
                analysis,
            },
            questions: [{ id: "question_1", field: "payment.status" }],
            rows: [{ rawData: { Name: "Asha" } }],
        });
        const { ImportQuestionService } = await import("@/importing/services/import-question.service");

        await ImportQuestionService.answerQuestion("user_1", "branch_1", "session_1", {
            questionId: "question_1",
            answer: "IMPORT_PAID_UNPAID",
        });

        const updateInput = mocks.prisma.importSession.update.mock.calls[0][0];
        expect(updateInput.data.mapping.analysis).toEqual(analysis);
        expect(updateInput.data.mapping.importOptions.paymentAction).toBe("IMPORT_PAID_UNPAID");
    });

    it("auto-confirms canonical paid due waived words when importing payment status", async () => {
        mocks.prisma.importSession.findFirst.mockResolvedValueOnce({
            id: "session_1",
            mapping: {
                entityTypesDetected: ["STUDENT", "PAYMENT"],
                columnMappings: [
                    { sourceColumn: "Name", targetField: "student.name", confidence: 95 },
                    { sourceColumn: "Payment Status", targetField: "payment.status", confidence: 95 },
                ],
                questions: [],
                warnings: [],
                importOptions: { paymentCycle: "CURRENT_MONTH" },
                analysis,
            },
            questions: [{ id: "question_1", field: "payment.status" }],
            rows: [
                { rawData: { Name: "Asha", "Payment Status": "PAID" } },
                { rawData: { Name: "Ravi", "Payment Status": "DUE" } },
                { rawData: { Name: "Meera", "Payment Status": "WAIVED" } },
            ],
        });
        const { ImportQuestionService } = await import("@/importing/services/import-question.service");

        await ImportQuestionService.answerQuestion("user_1", "branch_1", "session_1", {
            questionId: "question_1",
            answer: "IMPORT_PAID_UNPAID",
        });

        const updateInput = mocks.prisma.importSession.update.mock.calls[0][0];
        expect(updateInput.data.mapping.importOptions.paymentAction).toBe("IMPORT_PAID_UNPAID");
        expect(updateInput.data.mapping.importOptions.paymentMapping).toMatchObject({
            paidValues: ["PAID"],
            unpaidValues: ["DUE"],
            waivedValues: ["WAIVED"],
            unclearValues: [],
            confirmed: true,
        });
    });

    it("keeps payment words unconfirmed when an answered payment import has unclear values", async () => {
        mocks.prisma.importSession.findFirst.mockResolvedValueOnce({
            id: "session_1",
            mapping: {
                entityTypesDetected: ["STUDENT", "PAYMENT"],
                columnMappings: [
                    { sourceColumn: "Name", targetField: "student.name", confidence: 95 },
                    { sourceColumn: "Payment Status", targetField: "payment.status", confidence: 95 },
                ],
                questions: [],
                warnings: [],
                importOptions: { paymentCycle: "CURRENT_MONTH" },
                analysis,
            },
            questions: [{ id: "question_1", field: "payment.status" }],
            rows: [
                { rawData: { Name: "Asha", "Payment Status": "PAID" } },
                { rawData: { Name: "Ravi", "Payment Status": "PARTIAL" } },
            ],
        });
        const { ImportQuestionService } = await import("@/importing/services/import-question.service");

        await ImportQuestionService.answerQuestion("user_1", "branch_1", "session_1", {
            questionId: "question_1",
            answer: "IMPORT_PAID_UNPAID",
        });

        const updateInput = mocks.prisma.importSession.update.mock.calls[0][0];
        expect(updateInput.data.mapping.importOptions.paymentAction).toBe("IMPORT_PAID_UNPAID");
        expect(updateInput.data.mapping.importOptions.paymentMapping?.confirmed).not.toBe(true);
    });

    it("removes answered AI questions so revalidation does not recreate them", async () => {
        const sourceQuestion = {
            field: "payment.period",
            question: "How would you like to process cumulative historical values ('Total Paid', 'Total Due')?",
            options: ["IMPORT_PAID_UNPAID", "GENERATE_DUE", "SKIP_PAYMENTS"],
        };
        mocks.prisma.importSession.findFirst.mockResolvedValueOnce({
            id: "session_1",
            mapping: {
                entityTypesDetected: ["STUDENT", "PAYMENT"],
                columnMappings: [{ sourceColumn: "Name", targetField: "student.name", confidence: 95 }],
                questions: [sourceQuestion],
                warnings: [],
                importOptions: {},
                analysis,
            },
            questions: [{ id: "question_1", ...sourceQuestion }],
            rows: [{ rawData: { Name: "Asha", "Total Paid": "1200" } }],
        });
        const { ImportQuestionService } = await import("@/importing/services/import-question.service");

        await ImportQuestionService.answerQuestion("user_1", "branch_1", "session_1", {
            questionId: "question_1",
            answer: "IMPORT_PAID_UNPAID",
        });

        const updateInput = mocks.prisma.importSession.update.mock.calls[0][0];
        expect(updateInput.data.mapping.questions).toEqual([]);
        expect(updateInput.data.mapping.importOptions.paymentAction).toBe("IMPORT_PAID_UNPAID");
        expect(updateInput.data.mapping.importOptions.paymentCycle).toBe("USE_JOINED_AT_ANNIVERSARY");
    });

    it("treats skip payments as both cycle and action so payment prompts stop", async () => {
        mocks.prisma.importSession.findFirst.mockResolvedValueOnce({
            id: "session_1",
            mapping: {
                entityTypesDetected: ["STUDENT", "PAYMENT"],
                columnMappings: [{ sourceColumn: "Name", targetField: "student.name", confidence: 95 }],
                questions: [],
                warnings: [],
                importOptions: {},
                analysis,
            },
            questions: [{ id: "question_1", field: "payment.period", question: "Skip payments?" }],
            rows: [{ rawData: { Name: "Asha" } }],
        });
        const { ImportQuestionService } = await import("@/importing/services/import-question.service");

        await ImportQuestionService.answerQuestion("user_1", "branch_1", "session_1", {
            questionId: "question_1",
            answer: "SKIP_PAYMENTS",
        });

        const updateInput = mocks.prisma.importSession.update.mock.calls[0][0];
        expect(updateInput.data.mapping.importOptions).toMatchObject({
            paymentCycle: "SKIP_PAYMENTS",
            paymentAction: "SKIP_PAYMENTS",
        });
    });
});
