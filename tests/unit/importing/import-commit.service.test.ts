import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { format, subMonths } from "date-fns";
import { createImportPlanVersion } from "@/importing/utils/import-plan-checks";

const mocks = vi.hoisted(() => ({
    revalidateSession: vi.fn(),
    authorize: vi.fn(),
    prisma: {
        $transaction: vi.fn(),
        seat: { findMany: vi.fn() },
        shift: { findMany: vi.fn() },
        multiShift: { findMany: vi.fn() },
        payment: { deleteMany: vi.fn() },
        auditLog: { deleteMany: vi.fn() },
        seatAllocation: { deleteMany: vi.fn() },
        student: { deleteMany: vi.fn() },
        importSession: { findFirst: vi.fn(), update: vi.fn() },
        importRow: { update: vi.fn() },
        importCommit: { create: vi.fn() },
    },
    createImportedStudent: vi.fn(),
    assignSeatToShifts: vi.fn(),
    ensureMonthlyPaymentForStudent: vi.fn(),
    markPaymentAsPaid: vi.fn(),
    markPaymentAsWaived: vi.fn(),
    createSeat: vi.fn(),
    createShift: vi.fn(),
    createMultiShift: vi.fn(),
}));

vi.mock("@/importing/services/import-session.service", () => ({
    ImportSessionService: {
        revalidateSession: mocks.revalidateSession,
    },
}));

vi.mock("@/lib/prisma", () => ({
    prisma: mocks.prisma,
}));

vi.mock("@/services/staff.service", () => ({
    StaffService: {
        authorize: mocks.authorize,
    },
}));

vi.mock("@/services/student.service", () => ({
    StudentService: {
        createImportedStudent: mocks.createImportedStudent,
    },
}));

vi.mock("@/services/seatAllocation.service", () => ({
    SeatAllocationService: {
        assignSeatToShifts: mocks.assignSeatToShifts,
    },
}));

vi.mock("@/services/payment.service", () => ({
    PaymentService: {
        ensureMonthlyPaymentForStudent: mocks.ensureMonthlyPaymentForStudent,
        markPaymentAsPaid: mocks.markPaymentAsPaid,
        markPaymentAsWaived: mocks.markPaymentAsWaived,
    },
}));

vi.mock("@/services/seat.service", () => ({
    SeatService: {
        createSeat: mocks.createSeat,
    },
}));

vi.mock("@/services/shift.service", () => ({
    ShiftService: {
        createShift: mocks.createShift,
    },
}));

vi.mock("@/services/multiShift.service", () => ({
    MultiShiftService: {
        createMultiShift: mocks.createMultiShift,
    },
}));

const readyDetail = {
    status: "READY_TO_COMMIT",
    updatedAt: "2026-06-24T00:00:00.000Z",
    mapping: {
        importOptions: {
            paymentCycle: "CURRENT_MONTH",
            paymentAction: "IMPORT_PAID_UNPAID",
            paymentMapping: { confirmed: true, paidValues: ["paid"], unpaidValues: ["due"], waivedValues: [], unclearValues: [], defaultMethod: "CASH" },
        },
    },
    rows: [
        {
            id: "row_1",
            rowNumber: 2,
            status: "READY",
            skipped: false,
            warnings: [],
            normalizedData: {
                student: { name: "Asha", phone: "9876543210", monthlyFee: 1200, joinedAt: "2026-01-01T00:00:00.000Z" },
                allocation: { seatLabel: "A1", shiftName: "Morning" },
                payment: { amount: 1200, status: "PAID", method: "UPI", referenceId: "TXN1" },
            },
        },
    ],
};

function planVersionFor(detail: {
    status: string;
    mapping: unknown;
    rows: Array<{ id?: string; status: string; skipped?: boolean; normalizedData: unknown; issues?: unknown; warnings?: unknown }>;
}) {
    return createImportPlanVersion({
        sessionId: "session_1",
        status: detail.status,
        mapping: detail.mapping as never,
        rows: detail.rows.map(row => ({
            id: row.id,
            status: row.status,
            skipped: row.skipped,
            normalizedData: row.normalizedData as never,
            issues: row.issues,
            warnings: row.warnings,
        })),
    });
}

describe("ImportCommitService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
        mocks.authorize.mockResolvedValue(true);
        mocks.prisma.seat.findMany.mockResolvedValue([{ id: "seat_1", label: "A1" }]);
        mocks.prisma.shift.findMany.mockResolvedValue([{ id: "shift_1", name: "Morning" }]);
        mocks.prisma.multiShift.findMany.mockResolvedValue([]);
        mocks.prisma.$transaction.mockImplementation(async callback => callback(mocks.prisma));
        mocks.prisma.payment.deleteMany.mockResolvedValue({ count: 1 });
        mocks.prisma.auditLog.deleteMany.mockResolvedValue({ count: 0 });
        mocks.prisma.seatAllocation.deleteMany.mockResolvedValue({ count: 1 });
        mocks.prisma.student.deleteMany.mockResolvedValue({ count: 1 });
        mocks.prisma.importSession.findFirst.mockResolvedValue({ status: "READY_TO_COMMIT", updatedAt: new Date("2026-06-24T00:00:00.000Z") });
        mocks.prisma.importSession.update.mockResolvedValue({});
        mocks.prisma.importRow.update.mockResolvedValue({});
        mocks.prisma.importCommit.create.mockResolvedValue({});
        mocks.createImportedStudent.mockResolvedValue({ id: "student_1" });
        mocks.assignSeatToShifts.mockResolvedValue([{ id: "allocation_1" }]);
        mocks.ensureMonthlyPaymentForStudent.mockResolvedValue({ id: "payment_1" });
        mocks.markPaymentAsPaid.mockResolvedValue({ id: "payment_1", status: "PAID" });
        mocks.markPaymentAsWaived.mockResolvedValue({ id: "payment_1", status: "WAIVED" });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not run when the session is not READY_TO_COMMIT", async () => {
        const detail = {
            ...readyDetail,
            status: "NEEDS_INFO",
            questions: [{ status: "OPEN" }],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await expect(ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail))).rejects.toThrow("not ready");
        expect(mocks.createImportedStudent).not.toHaveBeenCalled();
    }, 10000);

    it("requires the reviewed plan version before committing", async () => {
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await expect(ImportCommitService.commitSession("user_1", "branch_1", "session_1")).rejects.toThrow("plan version");
        expect(mocks.revalidateSession).not.toHaveBeenCalled();
    });

    it("does not re-open a committed session", async () => {
        mocks.prisma.importSession.findFirst.mockResolvedValueOnce({ status: "COMMITTED", updatedAt: new Date("2026-06-24T00:00:00.000Z") });
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await expect(ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(readyDetail))).rejects.toThrow("already been committed");
        expect(mocks.revalidateSession).not.toHaveBeenCalled();
        expect(mocks.createImportedStudent).not.toHaveBeenCalled();
    });

    it("blocks a fresh in-progress commit", async () => {
        mocks.prisma.importSession.findFirst.mockResolvedValueOnce({ status: "COMMITTING", updatedAt: new Date() });
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await expect(ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(readyDetail))).rejects.toThrow("already running");
        expect(mocks.revalidateSession).not.toHaveBeenCalled();
        expect(mocks.createImportedStudent).not.toHaveBeenCalled();
    });

    it("allows a stale in-progress commit to retry remaining ready rows", async () => {
        mocks.prisma.importSession.findFirst.mockResolvedValueOnce({
            status: "COMMITTING",
            updatedAt: new Date(Date.now() - 31 * 60 * 1000),
        });
        mocks.revalidateSession.mockResolvedValueOnce(readyDetail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        const result = await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(readyDetail));

        expect(result.status).toBe("SUCCESS");
        expect(mocks.createImportedStudent).toHaveBeenCalledTimes(1);
    });

    it("imports valid student rows through StudentService", async () => {
        mocks.revalidateSession.mockResolvedValueOnce(readyDetail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        const result = await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(readyDetail));

        expect(result.status).toBe("SUCCESS");
        expect(mocks.createImportedStudent).toHaveBeenCalledWith("user_1", "branch_1", expect.objectContaining({ name: "Asha" }));
    });

    it("skips blocked rows in SAFE_PARTIAL mode", async () => {
        const detail = {
            ...readyDetail,
            rows: [
                ...readyDetail.rows,
                { id: "row_2", rowNumber: 3, status: "BLOCKED", skipped: false, warnings: [], normalizedData: { student: {} } },
            ],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        const result = await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail));

        expect(result.status).toBe("PARTIAL");
        expect(result.summary.skippedRows).toBe(1);
        expect(mocks.createImportedStudent).toHaveBeenCalledTimes(1);
        expect(mocks.prisma.importCommit.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: "PARTIAL" }),
        }));
    });

    it("safe partial ignores payment blockers from rows that will not import", async () => {
        const detail = {
            ...readyDetail,
            status: "VALIDATED",
            mapping: {
                importOptions: {
                    paymentCycle: "CURRENT_MONTH",
                    paymentAction: "IMPORT_PAID_UNPAID",
                },
            },
            rows: [
                {
                    ...readyDetail.rows[0],
                    warnings: [{
                        code: "PAYMENT_STATUS_MAPPING_UNCONFIRMED",
                        field: "payment.status",
                        message: "Paid/unpaid mapping must be confirmed before importing payment status.",
                        severity: "warning",
                    }],
                    normalizedData: {
                        ...readyDetail.rows[0].normalizedData,
                        payment: { amount: 1200, status: "PAID", rawStatus: "PAID" },
                    },
                },
                {
                    id: "row_2",
                    rowNumber: 3,
                    status: "BLOCKED",
                    skipped: false,
                    issues: [{ code: "MISSING_STUDENT_NAME", message: "Student name is required.", severity: "error" }],
                    warnings: [{
                        code: "AMBIGUOUS_PAYMENT_STATUS",
                        field: "payment.status",
                        message: "Payment value \"PARTIAL\" is unclear.",
                        severity: "warning",
                    }],
                    normalizedData: {
                        payment: { amount: 1200, status: "UNCLEAR", rawStatus: "PARTIAL" },
                    },
                },
            ],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        const result = await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail));

        expect(result.status).toBe("PARTIAL");
        expect(result.summary.createdStudents).toBe(1);
        expect(result.summary.skippedRows).toBe(1);
        expect(mocks.createImportedStudent).toHaveBeenCalledTimes(1);
        expect(mocks.markPaymentAsPaid).toHaveBeenCalled();
    });

    it("refuses blocked rows in STRICT_ALL_OR_NOTHING mode", async () => {
        const detail = {
            ...readyDetail,
            rows: [
                ...readyDetail.rows,
                { id: "row_2", rowNumber: 3, status: "BLOCKED", skipped: false, warnings: [], normalizedData: { student: {} } },
            ],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await expect(ImportCommitService.commitSession("user_1", "branch_1", "session_1", "STRICT_ALL_OR_NOTHING", planVersionFor(detail))).rejects.toThrow("Strict import refused");
    });

    it("uses SeatAllocationService for allocations", async () => {
        mocks.revalidateSession.mockResolvedValueOnce(readyDetail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(readyDetail));

        expect(mocks.assignSeatToShifts).toHaveBeenCalledWith("user_1", "seat_1", "student_1", ["shift_1"]);
    });

    it("imports the student but skips seat allocation for deferred allocation conflicts", async () => {
        const detail = {
            ...readyDetail,
            mapping: {
                importOptions: {
                    paymentCycle: "SKIP_PAYMENTS",
                    paymentAction: "SKIP_PAYMENTS",
                    skipConflictingAllocations: true,
                },
            },
            rows: [{
                ...readyDetail.rows[0],
                status: "WARNING",
                warnings: [{
                    code: "ALLOCATION_SKIPPED_CONFLICT",
                    field: "allocation.seatLabel",
                    message: "Student will import without allocation because seat A1 is already occupied.",
                    severity: "info",
                }],
                normalizedData: {
                    student: { name: "Asha", phone: "9876543210", monthlyFee: 1200 },
                    allocation: { seatLabel: "A1", shiftName: "Morning" },
                },
            }],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        const result = await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail));

        expect(result.status).toBe("SUCCESS");
        expect(result.summary.createdStudents).toBe(1);
        expect(result.summary.createdAllocations).toBe(0);
        expect(mocks.createImportedStudent).toHaveBeenCalledWith("user_1", "branch_1", expect.objectContaining({ name: "Asha" }));
        expect(mocks.assignSeatToShifts).not.toHaveBeenCalled();
        expect(mocks.authorize).not.toHaveBeenCalledWith("user_1", "branch_1", "seat_allocation");
    });

    it("links imported students to selected shift fees when the fee came from branch pricing", async () => {
        const detail = {
            ...readyDetail,
            rows: [{
                ...readyDetail.rows[0],
                normalizedData: {
                    ...readyDetail.rows[0].normalizedData,
                    student: {
                        ...readyDetail.rows[0].normalizedData.student,
                        monthlyFee: 1200,
                        feeSource: "SHIFT_PRICE",
                        feeLinkedShiftName: "Morning",
                    },
                },
            }],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail));

        expect(mocks.createImportedStudent).toHaveBeenCalledWith(
            "user_1",
            "branch_1",
            expect.objectContaining({ feeLinkedShiftId: "shift_1", feeLinkedMultiShiftId: undefined })
        );
    });

    it("expands a known Full Time multi-shift from a plain shift value", async () => {
        mocks.prisma.shift.findMany.mockResolvedValueOnce([
            { id: "shift_morning", name: "Morning" },
            { id: "shift_afternoon", name: "Afternoon" },
            { id: "shift_evening", name: "Evening" },
        ]);
        mocks.prisma.multiShift.findMany.mockResolvedValueOnce([{
            id: "multi_full_time",
            name: "Full Time",
            components: [
                { shiftId: "shift_morning", shift: { name: "Morning" } },
                { shiftId: "shift_afternoon", shift: { name: "Afternoon" } },
                { shiftId: "shift_evening", shift: { name: "Evening" } },
            ],
        }]);
        mocks.assignSeatToShifts.mockResolvedValueOnce([
            { id: "allocation_morning" },
            { id: "allocation_afternoon" },
            { id: "allocation_evening" },
        ]);
        const detail = {
            ...readyDetail,
            rows: [{
                ...readyDetail.rows[0],
                normalizedData: {
                    ...readyDetail.rows[0].normalizedData,
                    allocation: { seatLabel: "A1", shiftName: "Full Time" },
                },
            }],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail));

        expect(mocks.assignSeatToShifts).toHaveBeenCalledWith(
            "user_1",
            "seat_1",
            "student_1",
            ["shift_morning", "shift_afternoon", "shift_evening"],
            "multi_full_time"
        );
    });

    it("uses PaymentService for generated and paid transitions", async () => {
        mocks.revalidateSession.mockResolvedValueOnce(readyDetail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(readyDetail));

        expect(mocks.ensureMonthlyPaymentForStudent).toHaveBeenCalled();
        expect(mocks.markPaymentAsPaid).toHaveBeenCalledWith("user_1", "payment_1", "UPI", "TXN1");
    });

    it("starts at the current joined-date cycle without creating future dues", async () => {
        const detail = {
            ...readyDetail,
            mapping: {
                importOptions: {
                    paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
                    paymentAction: "GENERATE_DUE",
                    paymentHistoryMode: "START_CURRENT_JOINED_CYCLE",
                },
            },
            rows: [{
                ...readyDetail.rows[0],
                normalizedData: {
                    student: { name: "Asha", phone: "9876543210", monthlyFee: 1200, joinedAt: "2026-01-12T00:00:00.000Z" },
                },
            }],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        const result = await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail));
        const createInput = mocks.createImportedStudent.mock.calls[0][2];

        expect(result.summary.generatedPayments).toBe(0);
        expect(result.summary.skippedHistoricalPayments).toBe(5);
        expect(format(createInput.billingStartAt, "yyyy-MM-dd")).toBe("2026-06-12");
        expect(mocks.ensureMonthlyPaymentForStudent).not.toHaveBeenCalled();
    });

    it("can generate joined-date history and mark every due cycle paid", async () => {
        const detail = {
            ...readyDetail,
            mapping: {
                importOptions: {
                    paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
                    paymentAction: "GENERATE_DUE",
                    paymentHistoryMode: "FROM_JOINED_MARK_PAID",
                },
            },
            rows: [{
                ...readyDetail.rows[0],
                normalizedData: {
                    student: { name: "Asha", phone: "9876543210", monthlyFee: 1200, joinedAt: "2026-01-01T00:00:00.000Z" },
                },
            }],
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        const result = await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail));

        expect(mocks.ensureMonthlyPaymentForStudent).toHaveBeenCalledTimes(6);
        expect(mocks.markPaymentAsPaid).toHaveBeenCalledTimes(6);
        expect(result.summary.generatedPayments).toBe(6);
        expect(result.summary.markedPaid).toBe(6);
        expect(result.summary.historicalPaid).toBe(5);
        expect(result.summary.currentCyclePayments).toBe(1);
    });

    it("rolls back row-created records when a later row step fails", async () => {
        mocks.revalidateSession.mockResolvedValueOnce(readyDetail);
        mocks.markPaymentAsPaid.mockRejectedValueOnce(new Error("Paid update failed"));
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        const result = await ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(readyDetail));

        expect(result.status).toBe("FAILED");
        expect(result.summary.createdStudents).toBe(0);
        expect(result.summary.createdAllocations).toBe(0);
        expect(result.summary.generatedPayments).toBe(0);
        expect(result.summary.failedRows).toBe(1);
        expect(mocks.prisma.auditLog.deleteMany).toHaveBeenCalledWith({ where: { paymentId: { in: ["payment_1"] } } });
        expect(mocks.prisma.payment.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["payment_1"] } } });
        expect(mocks.prisma.seatAllocation.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["allocation_1"] } } });
        expect(mocks.prisma.student.deleteMany).toHaveBeenCalledWith({ where: { id: "student_1" } });
        expect(mocks.prisma.importRow.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: "FAILED" }),
        }));
        expect(mocks.prisma.importCommit.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: "FAILED" }),
        }));
        expect(mocks.prisma.importSession.update).toHaveBeenLastCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: "FAILED" }),
        }));
    });

    it("refuses commits when payment action and cycle conflict", async () => {
        const detail = {
            ...readyDetail,
            mapping: {
                importOptions: {
                    paymentAction: "GENERATE_DUE",
                    paymentCycle: "SKIP_PAYMENTS",
                },
            },
        };
        mocks.revalidateSession.mockResolvedValueOnce(detail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await expect(ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", planVersionFor(detail))).rejects.toThrow("Payment plan");
        expect(mocks.createImportedStudent).not.toHaveBeenCalled();
    });

    it("rejects stale plan versions after revalidation changes the session", async () => {
        mocks.revalidateSession.mockResolvedValueOnce(readyDetail);
        const { ImportCommitService } = await import("@/importing/services/import-commit.service");

        await expect(ImportCommitService.commitSession("user_1", "branch_1", "session_1", "SAFE_PARTIAL", "stale-plan")).rejects.toThrow("plan changed");
        expect(mocks.createImportedStudent).not.toHaveBeenCalled();
    });

    it("previews generated dues for student-only rows when payment generation is enabled", async () => {
        mocks.revalidateSession.mockResolvedValueOnce({
            status: "READY_TO_COMMIT",
            mapping: {
                importOptions: {
                    paymentCycle: "CURRENT_MONTH",
                    paymentAction: "GENERATE_DUE",
                },
            },
            questions: [],
            rows: [{
                id: "row_1",
                rowNumber: 2,
                status: "READY",
                skipped: false,
                issues: [],
                warnings: [],
                normalizedData: {
                    student: {
                        name: "Asha",
                        phone: "9876543210",
                        monthlyFee: 1200,
                        joinedAt: subMonths(new Date(), 1).toISOString(),
                    },
                },
            }],
        });
        const { ImportPreviewService } = await import("@/importing/services/import-preview.service");

        const preview = await ImportPreviewService.getPreview("user_1", "branch_1", "session_1");

        expect(preview.summary.generatePayments).toBe(1);
        expect(preview.summary.markPaid).toBe(0);
    });

    it("previews one allocation per component shift for multi-shift rows", async () => {
        mocks.revalidateSession.mockResolvedValueOnce({
            status: "READY_TO_COMMIT",
            mapping: {
                importOptions: {
                    paymentCycle: "SKIP_PAYMENTS",
                    paymentAction: "SKIP_PAYMENTS",
                },
            },
            questions: [],
            rows: [{
                id: "row_1",
                rowNumber: 2,
                status: "READY",
                skipped: false,
                issues: [],
                warnings: [],
                normalizedData: {
                    student: { name: "Asha", phone: "9876543210", monthlyFee: 2400 },
                    allocation: { seatLabel: "A1", multiShiftName: "Full Time" },
                    multiShift: { name: "Full Time", componentShiftNames: ["Morning", "Afternoon", "Evening"] },
                },
            }],
        });
        const { ImportPreviewService } = await import("@/importing/services/import-preview.service");

        const preview = await ImportPreviewService.getPreview("user_1", "branch_1", "session_1");

        expect(preview.summary.createAllocations).toBe(3);
    });

    it("previews safe partial as committable when blocked rows have unresolved payment words", async () => {
        mocks.revalidateSession.mockResolvedValueOnce({
            status: "VALIDATED",
            mapping: {
                importOptions: {
                    paymentCycle: "CURRENT_MONTH",
                    paymentAction: "IMPORT_PAID_UNPAID",
                },
            },
            questions: [],
            rows: [
                {
                    id: "row_1",
                    rowNumber: 2,
                    status: "WARNING",
                    skipped: false,
                    issues: [],
                    warnings: [{
                        code: "PAYMENT_STATUS_MAPPING_UNCONFIRMED",
                        field: "payment.status",
                        message: "Paid/unpaid mapping must be confirmed before importing payment status.",
                        severity: "warning",
                    }],
                    normalizedData: {
                        student: { name: "Asha", phone: "9876543210", monthlyFee: 1200 },
                        payment: { amount: 1200, status: "PAID", rawStatus: "PAID" },
                    },
                },
                {
                    id: "row_2",
                    rowNumber: 3,
                    status: "BLOCKED",
                    skipped: false,
                    issues: [{ code: "MISSING_STUDENT_NAME", message: "Student name is required.", severity: "error" }],
                    warnings: [{
                        code: "AMBIGUOUS_PAYMENT_STATUS",
                        field: "payment.status",
                        message: "Payment value \"PARTIAL\" is unclear.",
                        severity: "warning",
                    }],
                    normalizedData: {
                        payment: { amount: 1200, status: "UNCLEAR", rawStatus: "PARTIAL" },
                    },
                },
            ],
        });
        const { ImportPreviewService } = await import("@/importing/services/import-preview.service");

        const preview = await ImportPreviewService.getPreview("user_1", "branch_1", "session_1", "SAFE_PARTIAL");

        expect(preview.canCommit).toBe(true);
        expect(preview.summary.createStudents).toBe(1);
        expect(preview.summary.blockedRows).toBe(1);
        expect(preview.checks.find(check => check.code === "PAYMENT_WORDS")).toMatchObject({
            status: "pass",
        });
    });
});
