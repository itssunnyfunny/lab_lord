import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentMethod, PaymentStatus, PaymentType, StudentStatus } from "@/types";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    assertBranchWritable: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/staff.service", () => ({
    StaffService: { authorize: mocks.authorize },
}));
vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: mocks.assertBranchWritable },
}));

function transaction(existing: Record<string, unknown>) {
    return {
        student: {
            findUnique: vi.fn().mockResolvedValue({
                id: "student_1",
                branchId: "branch_1",
                monthlyFee: 1200,
                status: StudentStatus.ACTIVE,
            }),
        },
        payment: {
            findUnique: vi.fn().mockResolvedValue(existing),
            create: vi.fn(),
        },
        branch: { update: vi.fn() },
    };
}

const periodStart = new Date(2026, 0, 1);
const periodEnd = new Date(2026, 1, 1);

function exactExisting(overrides: Record<string, unknown> = {}) {
    return {
        id: "payment_1",
        branchId: "branch_1",
        studentId: "student_1",
        amount: 1200,
        status: PaymentStatus.DUE,
        type: PaymentType.MONTHLY,
        periodStart,
        periodEnd,
        dueDate: periodEnd,
        paymentMethod: null,
        referenceId: null,
        ...overrides,
    };
}

describe("PaymentService exact imported cycle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("rejects a same-start payment whose amount differs from the reviewed cycle", async () => {
        const tx = transaction(exactExisting({ amount: 1500 }));
        const { PaymentService } = await import("@/services/payment.service");

        await expect(PaymentService.ensureMonthlyPaymentForStudentInTransaction("user_1", "branch_1", {
            studentId: "student_1",
            periodStart,
            periodEnd,
            dueDate: periodEnd,
            amount: 1200,
            strictExisting: { targetStatus: PaymentStatus.DUE },
        }, tx as never)).rejects.toThrow("does not match the reviewed cycle");

        expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it.each([
        ["branch", { branchId: "branch_2" }],
        ["type", { type: PaymentType.ADMISSION }],
        ["period end", { periodEnd: new Date(2026, 1, 2) }],
        ["due date", { dueDate: new Date(2026, 1, 2) }],
        ["status", { status: PaymentStatus.PAID }],
    ])("rejects an existing cycle with a different reviewed %s", async (_field, override) => {
        const tx = transaction(exactExisting(override));
        const { PaymentService } = await import("@/services/payment.service");

        await expect(PaymentService.ensureMonthlyPaymentForStudentInTransaction("user_1", "branch_1", {
            studentId: "student_1",
            periodStart,
            periodEnd,
            dueDate: periodEnd,
            amount: 1200,
            strictExisting: { targetStatus: PaymentStatus.DUE },
        }, tx as never)).rejects.toThrow("does not match the reviewed cycle");
    });

    it("rejects mismatched method/reference metadata on an already-paid reviewed cycle", async () => {
        const tx = transaction(exactExisting({
            status: PaymentStatus.PAID,
            paymentMethod: PaymentMethod.CASH,
            referenceId: "cash_receipt",
        }));
        const { PaymentService } = await import("@/services/payment.service");

        await expect(PaymentService.ensureMonthlyPaymentForStudentInTransaction("user_1", "branch_1", {
            studentId: "student_1",
            periodStart,
            periodEnd,
            dueDate: periodEnd,
            amount: 1200,
            strictExisting: {
                targetStatus: PaymentStatus.PAID,
                paymentMethod: PaymentMethod.UPI,
                referenceId: "txn_1",
            },
        }, tx as never)).rejects.toThrow("does not match the reviewed cycle");
    });

    it("reuses an exact DUE precursor for a reviewed PAID transition", async () => {
        const existing = exactExisting();
        const tx = transaction(existing);
        const { PaymentService } = await import("@/services/payment.service");

        await expect(PaymentService.ensureMonthlyPaymentForStudentInTransaction("user_1", "branch_1", {
            studentId: "student_1",
            periodStart,
            periodEnd,
            dueDate: periodEnd,
            amount: 1200,
            strictExisting: {
                targetStatus: PaymentStatus.PAID,
                paymentMethod: PaymentMethod.UPI,
                referenceId: "txn_1",
            },
        }, tx as never)).resolves.toBe(existing);

        expect(tx.payment.create).not.toHaveBeenCalled();
    });
});
