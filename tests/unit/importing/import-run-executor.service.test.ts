import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        importRunItem: { findFirst: vi.fn() },
        shift: { findFirst: vi.fn() },
        multiShift: { findFirst: vi.fn() },
    };
    return {
        tx,
        transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
        createStudent: vi.fn(),
        ensurePayment: vi.fn(),
        markPaid: vi.fn(),
        markWaived: vi.fn(),
        completeItem: vi.fn(),
    };
});

vi.mock("@/lib/prisma", () => ({
    prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/services/student.service", () => ({
    StudentService: { createImportedStudentInTransaction: mocks.createStudent },
}));
vi.mock("@/services/multiShift.service", () => ({
    MultiShiftService: { createMultiShiftInTransaction: vi.fn() },
}));
vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: vi.fn() },
}));
vi.mock("@/services/payment.service", () => ({
    PaymentService: {
        ensureMonthlyPaymentForStudentInTransaction: mocks.ensurePayment,
        markPaymentAsPaidInTransaction: mocks.markPaid,
        markPaymentAsWaivedInTransaction: mocks.markWaived,
    },
}));
vi.mock("@/services/seat.service", () => ({
    SeatService: {},
}));
vi.mock("@/services/seatAllocation.service", () => ({
    SeatAllocationService: {},
}));
vi.mock("@/services/shift.service", () => ({
    ShiftService: {},
}));
vi.mock("@/services/staff.service", () => ({
    StaffService: { authorize: vi.fn() },
}));
vi.mock("@/importing/services/import-runner.service", () => ({
    ImportRunRunner: { completeItemInTransaction: mocks.completeItem },
}));

const claimedItem = {
    id: "item_1",
    importRunId: "run_1",
    importRowId: "row_1",
    evaluationId: "evaluation_1",
    ordinal: 0,
    itemKey: "row:row_1:student",
    kind: "STUDENT" as const,
    idempotencyKey: "run_1:row:row_1:student",
    requestHash: "request_hash",
    leaseToken: "lease_1",
    attemptCount: 1,
    rowNumber: 2,
    payload: null,
    mappedData: null,
    normalizedData: null,
    issues: [],
    warnings: [],
};

describe("ImportRunExecutor current configuration fencing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "run_1" }]);
        mocks.tx.importRunItem.findFirst.mockResolvedValue({
            id: "item_1",
            importRunId: "run_1",
            kind: "STUDENT",
            status: "RUNNING",
            leaseToken: "lease_1",
            payload: {
                student: {
                    name: "Asha",
                    monthlyFee: 1200,
                    feeLinkedShiftName: "Morning",
                },
                billingStartAt: null,
            },
            run: {
                id: "run_1",
                branchId: "branch_1",
                requestedByUserId: "user_1",
                targetRevision: 4,
                status: "RUNNING",
                session: {
                    id: "session_1",
                    branchId: "branch_1",
                    engineVersion: 2,
                    draftRevision: 4,
                    activeEvaluationRevision: 4,
                    archivedAt: null,
                },
                plan: { id: "plan_1", revision: 4, canRun: true },
            },
        });
    });

    it("rejects a linked shift price change inside the item transaction", async () => {
        mocks.tx.shift.findFirst.mockResolvedValue({
            id: "shift_1",
            branchId: "branch_1",
            price: 1500,
            status: "ACTIVE",
        });
        const { ImportRunExecutor } = await import("@/importing/services/import-run-executor.service");

        await expect(ImportRunExecutor.executeClaimedItem(claimedItem))
            .rejects.toThrow("reviewed linked shift price changed");

        expect(mocks.tx.shift.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ branchId: "branch_1", status: "ACTIVE" }),
            select: { id: true, branchId: true, price: true, status: true },
        }));
        expect(mocks.createStudent).not.toHaveBeenCalled();
        expect(mocks.completeItem).not.toHaveBeenCalled();
    });

    it("requests an exact existing-cycle fence before applying payment status", async () => {
        mocks.tx.importRunItem.findFirst.mockResolvedValue({
            id: "item_1",
            importRunId: "run_1",
            kind: "PAYMENT_CYCLE",
            status: "RUNNING",
            leaseToken: "lease_1",
            payload: {
                studentId: "student_1",
                bucket: "historical",
                status: "PAID",
                amount: 1200,
                method: "UPI",
                referenceId: "txn_1",
                cycle: {
                    periodStart: "2026-01-01T00:00:00.000Z",
                    periodEnd: "2026-02-01T00:00:00.000Z",
                    dueDate: "2026-02-01T00:00:00.000Z",
                },
            },
            run: {
                id: "run_1",
                branchId: "branch_1",
                requestedByUserId: "user_1",
                targetRevision: 4,
                status: "RUNNING",
                session: {
                    id: "session_1",
                    branchId: "branch_1",
                    engineVersion: 2,
                    draftRevision: 4,
                    activeEvaluationRevision: 4,
                    archivedAt: null,
                },
                plan: { id: "plan_1", revision: 4, canRun: true },
            },
        });
        mocks.ensurePayment.mockResolvedValue({ id: "payment_1" });
        const { ImportRunExecutor } = await import("@/importing/services/import-run-executor.service");

        await ImportRunExecutor.executeClaimedItem({ ...claimedItem, kind: "PAYMENT_CYCLE" });

        expect(mocks.ensurePayment).toHaveBeenCalledWith(
            "user_1",
            "branch_1",
            expect.objectContaining({
                studentId: "student_1",
                amount: 1200,
                strictExisting: {
                    targetStatus: "PAID",
                    paymentMethod: "UPI",
                    referenceId: "txn_1",
                },
            }),
            mocks.tx
        );
        expect(mocks.markPaid).toHaveBeenCalledWith(
            "user_1",
            "payment_1",
            "UPI",
            "txn_1",
            mocks.tx,
            { source: "IMPORT_EXECUTION" }
        );
        expect(mocks.completeItem).toHaveBeenCalled();
    });

    it("passes the import execution source when waiving a payment", async () => {
        mocks.tx.importRunItem.findFirst.mockResolvedValue({
            id: "item_1",
            importRunId: "run_1",
            kind: "PAYMENT_CYCLE",
            status: "RUNNING",
            leaseToken: "lease_1",
            payload: {
                studentId: "student_1",
                bucket: "current",
                status: "WAIVED",
                amount: 1200,
                cycle: {
                    periodStart: "2026-01-01T00:00:00.000Z",
                    periodEnd: "2026-02-01T00:00:00.000Z",
                    dueDate: "2026-02-01T00:00:00.000Z",
                },
            },
            run: {
                id: "run_1",
                branchId: "branch_1",
                requestedByUserId: "user_1",
                targetRevision: 4,
                status: "RUNNING",
                session: {
                    id: "session_1",
                    branchId: "branch_1",
                    engineVersion: 2,
                    draftRevision: 4,
                    activeEvaluationRevision: 4,
                    archivedAt: null,
                },
                plan: { id: "plan_1", revision: 4, canRun: true },
            },
        });
        mocks.ensurePayment.mockResolvedValue({ id: "payment_1" });
        const { ImportRunExecutor } = await import("@/importing/services/import-run-executor.service");

        await ImportRunExecutor.executeClaimedItem({ ...claimedItem, kind: "PAYMENT_CYCLE" });

        expect(mocks.markWaived).toHaveBeenCalledWith(
            "user_1",
            "payment_1",
            mocks.tx,
            { source: "IMPORT_EXECUTION" }
        );
        expect(mocks.completeItem).toHaveBeenCalled();
    });

    it("treats a SUCCEEDED payment item as a replay without resolving it again", async () => {
        mocks.tx.importRunItem.findFirst.mockResolvedValue({
            id: "item_1",
            importRunId: "run_1",
            kind: "PAYMENT_CYCLE",
            status: "SUCCEEDED",
            leaseToken: null,
            payload: null,
        });
        const { ImportRunExecutor } = await import("@/importing/services/import-run-executor.service");

        await expect(ImportRunExecutor.executeClaimedItem({ ...claimedItem, kind: "PAYMENT_CYCLE" }))
            .resolves.toEqual({ alreadyCompleted: true });

        expect(mocks.ensurePayment).not.toHaveBeenCalled();
        expect(mocks.markPaid).not.toHaveBeenCalled();
        expect(mocks.markWaived).not.toHaveBeenCalled();
        expect(mocks.completeItem).not.toHaveBeenCalled();
    });
});
