import { prisma } from "@/lib/prisma";
import { MESSAGE_DRAFT_ACTION_PREFIX } from "@/lib/messageDrafts";
import { StaffService } from "@/services/staff.service";
import { PaymentStatus, StudentStatus, PaymentType, PaymentMethod } from "@/types";
import type { StaffAction } from "@/types";
import type { Prisma } from "@/app/generated/prisma/client";
import { startOfDay, startOfMonth, endOfMonth } from "date-fns";
import { dueCyclesThrough } from "@/utils/studentBillingCycles";

const STUDENT_GENERATION_BATCH_SIZE = 250;
const PAYMENT_INSERT_BATCH_SIZE = 1000;

type PaymentGenerationSummary = {
    generatedCount: number;
    skippedCount: number;
    totalStudents: number;
    updatedBranchIds: string[];
};

export class PaymentService {
    /**
     * Helper to verify that the user owns the branch via its organization.
     */
    static async assertBranchOwnership(userId: string, branchId: string) {
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            include: {
                organization: true,
            },
        });

        if (!branch) {
            throw new Error("Branch not found");
        }

        if (branch.organization.ownerId !== userId) {
            throw new Error("Unauthorized: User does not own this branch");
        }

        return branch;
    }

    static async assertBranchAccess(userId: string, branchId: string, action: StaffAction) {
        await StaffService.authorize(userId, branchId, action);

        const branch = await prisma.branch.findUnique({ where: { id: branchId } });

        if (!branch) {
            throw new Error("Branch not found");
        }

        return branch;
    }

    private static async createPaymentBatch(
        paymentsToCreate: Prisma.PaymentCreateManyInput[],
        changedBranchIds: Set<string>,
        studentsWithCreatedPayments: Set<string>
    ) {
        if (paymentsToCreate.length === 0) {
            return 0;
        }

        const createdPayments = await prisma.payment.createManyAndReturn({
            data: paymentsToCreate,
            skipDuplicates: true,
            select: {
                branchId: true,
                studentId: true,
            },
        });

        for (const payment of createdPayments) {
            changedBranchIds.add(payment.branchId);
            studentsWithCreatedPayments.add(payment.studentId);
        }

        return createdPayments.length;
    }

    private static paymentDueDateKey(studentId: string, dueDate: Date | string) {
        return `${studentId}:${startOfDay(new Date(dueDate)).toISOString()}`;
    }

    private static async generateMissingDuePayments(params: {
        branchId?: string;
        asOfDate?: Date;
    }): Promise<PaymentGenerationSummary> {
        const { branchId, asOfDate = new Date() } = params;
        const today = startOfDay(asOfDate);
        const changedBranchIds = new Set<string>();
        const studentsWithCreatedPayments = new Set<string>();

        let generatedCount = 0;
        let totalStudents = 0;
        let cursor: string | undefined;
        let paymentsToCreate: Prisma.PaymentCreateManyInput[] = [];

        while (true) {
            const students = await prisma.student.findMany({
                where: {
                    ...(branchId ? { branchId } : {}),
                    status: StudentStatus.ACTIVE,
                },
                select: {
                    id: true,
                    branchId: true,
                    joinedAt: true,
                    billingStartAt: true,
                    monthlyFee: true,
                },
                orderBy: { id: "asc" },
                take: STUDENT_GENERATION_BATCH_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });

            if (students.length === 0) {
                break;
            }

            totalStudents += students.length;
            cursor = students[students.length - 1].id;
            const batchPaymentsToCreate: Prisma.PaymentCreateManyInput[] = [];

            for (const student of students) {
                for (const cycle of dueCyclesThrough(student.joinedAt, today, student.billingStartAt)) {
                    batchPaymentsToCreate.push({
                        branchId: student.branchId,
                        studentId: student.id,
                        amount: student.monthlyFee,
                        status: PaymentStatus.DUE,
                        type: PaymentType.MONTHLY,
                        periodStart: cycle.periodStart,
                        periodEnd: cycle.periodEnd,
                        dueDate: cycle.dueDate,
                    });
                }
            }

            const existingMonthlyPayments = await prisma.payment.findMany({
                where: {
                    type: PaymentType.MONTHLY,
                    studentId: { in: students.map(student => student.id) },
                    dueDate: { lte: today },
                },
                select: {
                    studentId: true,
                    dueDate: true,
                },
            });
            const existingDueDates = new Set(
                existingMonthlyPayments.map(payment =>
                    this.paymentDueDateKey(payment.studentId, payment.dueDate)
                )
            );

            for (const payment of batchPaymentsToCreate) {
                if (existingDueDates.has(this.paymentDueDateKey(payment.studentId, payment.dueDate))) {
                    continue;
                }

                paymentsToCreate.push(payment);

                if (paymentsToCreate.length >= PAYMENT_INSERT_BATCH_SIZE) {
                    generatedCount += await this.createPaymentBatch(
                        paymentsToCreate,
                        changedBranchIds,
                        studentsWithCreatedPayments
                    );
                    paymentsToCreate = [];
                }
            }

            if (paymentsToCreate.length >= PAYMENT_INSERT_BATCH_SIZE) {
                generatedCount += await this.createPaymentBatch(
                    paymentsToCreate,
                    changedBranchIds,
                    studentsWithCreatedPayments
                );
                paymentsToCreate = [];
            }
        }

        if (paymentsToCreate.length > 0) {
            generatedCount += await this.createPaymentBatch(
                paymentsToCreate,
                changedBranchIds,
                studentsWithCreatedPayments
            );
        }

        if (changedBranchIds.size > 0) {
            await prisma.branch.updateMany({
                where: { id: { in: Array.from(changedBranchIds) } },
                data: { lastDataChange: new Date() },
            });
        }

        return {
            generatedCount,
            skippedCount: Math.max(totalStudents - studentsWithCreatedPayments.size, 0),
            totalStudents,
            updatedBranchIds: Array.from(changedBranchIds),
        };
    }

    /**
     * Generates due payments for all ACTIVE students in a branch after checking
     * that the actor has explicit payment-generation permission.
     */
    static async generateDuePaymentsForBranch(
        userId: string,
        branchId: string,
        asOfDate: Date = new Date()
    ) {
        await this.assertBranchAccess(userId, branchId, "generate_payments");
        return this.generateMissingDuePayments({ branchId, asOfDate });
    }

    /**
     * Ensures a branch has all currently due monthly payments. Intended for
     * trusted system flows after branch access has already been confirmed.
     */
    static async ensureDuePaymentsForBranch(
        branchId: string,
        asOfDate: Date = new Date()
    ) {
        return this.generateMissingDuePayments({ branchId, asOfDate });
    }

    /**
     * Cron entrypoint for generating due payments across every branch.
     */
    static async generateDuePaymentsForAllActiveStudents(asOfDate: Date = new Date()) {
        return this.generateMissingDuePayments({ asOfDate });
    }

    static async ensureMonthlyPaymentForStudent(
        userId: string,
        branchId: string,
        data: {
            studentId: string;
            periodStart: Date;
            periodEnd: Date;
            dueDate?: Date;
            amount?: number;
        }
    ) {
        await this.assertBranchAccess(userId, branchId, "generate_payments");

        const periodStart = startOfDay(data.periodStart);
        const periodEnd = startOfDay(data.periodEnd);
        const dueDate = startOfDay(data.dueDate ?? data.periodEnd);

        const student = await prisma.student.findUnique({
            where: { id: data.studentId },
            select: { id: true, branchId: true, monthlyFee: true, status: true },
        });

        if (!student) throw new Error("Student not found");
        if (student.branchId !== branchId) throw new Error("Student does not belong to this branch");
        if (student.status !== StudentStatus.ACTIVE) throw new Error("Only ACTIVE students can receive monthly payments");

        const existing = await prisma.payment.findUnique({
            where: {
                studentId_periodStart: {
                    studentId: student.id,
                    periodStart,
                },
            },
        });

        if (existing) return existing;

        const payment = await prisma.payment.create({
            data: {
                branchId,
                studentId: student.id,
                amount: data.amount ?? student.monthlyFee,
                status: PaymentStatus.DUE,
                type: PaymentType.MONTHLY,
                periodStart,
                periodEnd,
                dueDate,
            },
        });

        await prisma.branch.update({
            where: { id: branchId },
            data: { lastDataChange: new Date() },
        });

        return payment;
    }

    /**
     * Lists payments for a branch with optional status filter.
     * Supports strict monthly view logic:
     * - If month provided:
     *   - DUE: All due payments <= end of that month (includes overdue).
     *   - PAID/WAIVED: Only payments due IN that month (strict filter).
     */
    static async listPayments(
        userId: string,
        branchId: string,
        status?: PaymentStatus,
        month?: Date
    ) {
        await this.assertBranchAccess(userId, branchId, "view_payments");

        // Default all-time view excludes WAIVED unless a status or monthly history view asks for it.
        let whereClause: Prisma.PaymentWhereInput = {
            branchId,
            ...(status ? { status } : { status: { not: "WAIVED" } }),
        };

        if (month) {
            const start = startOfMonth(month);
            const end = endOfMonth(month);

            if (status === PaymentStatus.DUE) {
                // If asking strictly for DUE, show everything due before or during this month
                whereClause = {
                    ...whereClause,
                    status: PaymentStatus.DUE,
                    dueDate: { lte: end }
                };
            } else if (status === PaymentStatus.PAID || status === PaymentStatus.WAIVED) {
                // If asking strictly for resolved payments, show only this month
                whereClause = {
                    ...whereClause,
                    status,
                    dueDate: { gte: start, lte: end }
                };
            } else {
                // Mixed view (default):
                // Show DUE if (dueDate <= end)    <-- Includes past due
                // Show PAID/WAIVED if (start <= dueDate <= end) <-- Strict window for resolved payments
                whereClause = {
                    branchId,
                    AND: [
                        {
                            OR: [
                                {
                                    status: PaymentStatus.DUE,
                                    dueDate: { lte: end }
                                },
                                {
                                    status: PaymentStatus.PAID,
                                    dueDate: { gte: start, lte: end }
                                },
                                {
                                    status: PaymentStatus.WAIVED,
                                    dueDate: { gte: start, lte: end }
                                }
                            ]
                        }
                    ]
                };
            }
        }

        return prisma.payment.findMany({
            where: whereClause,
            include: {
                student: {
                    select: {
                        id: true,
                        name: true,
                        phone: true,
                        joinedAt: true,
                    },
                },
            },
            orderBy: {
                dueDate: "asc",
            },
        });
    }

    /**
     * Marks a payment as PAID.
     */
    static async markPaymentAsPaid(
        userId: string,
        paymentId: string,
        method?: PaymentMethod,
        referenceId?: string,
    ) {
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
        });

        if (!payment) {
            throw new Error("Payment not found");
        }

        await StaffService.authorize(userId, payment.branchId, "mark_payment_paid");

        if (payment.status === PaymentStatus.PAID) {
            return payment; // Already paid, idempotent
        }

        return prisma.$transaction(async (tx) => {
            // 1. Mark as PAID (write-once: method + referenceId set only here)
            const updatedPayment = await tx.payment.update({
                where: { id: paymentId },
                data: {
                    status: PaymentStatus.PAID,
                    paidAt: new Date(),
                    ...(method      ? { paymentMethod: method } : {}),
                    ...(referenceId ? { referenceId }           : {}),
                },
            });

            // 2. Delete associated MessageDrafts (stop pestering once paid)
            await tx.messageDraft.deleteMany({
                where: {
                    studentId: payment.studentId,
                    branchId: payment.branchId,
                    action: { startsWith: MESSAGE_DRAFT_ACTION_PREFIX }
                }
            });

            // 3. Update Branch lastDataChange
            await tx.branch.update({
                where: { id: payment.branchId },
                data: { lastDataChange: new Date() }
            });

            // 4. Create Audit Log
            await tx.auditLog.create({
                data: {
                    branchId: payment.branchId,
                    userId,
                    action: "PAYMENT_MARKED_PAID",
                    paymentId: payment.id,
                    details: {
                        from: payment.status,
                        to: "PAID",
                        amount: payment.amount,
                        method: method ?? null,
                        referenceId: referenceId ?? null,
                    }
                }
            });

            return updatedPayment;
        });
    }

    /**
     * Marks a payment as WAIVED.
     * WAIVED = owner consciously decided not to pursue this debt.
     * Preserves history; excluded from overdue/due analytics.
     */
    static async markPaymentAsWaived(userId: string, paymentId: string) {
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
        });

        if (!payment) {
            throw new Error("Payment not found");
        }

        await StaffService.authorize(userId, payment.branchId, "waive_payments");

        if (payment.status === PaymentStatus.WAIVED) {
            return payment; // Already waived, idempotent
        }

        return prisma.$transaction(async (tx) => {
            const updatedPayment = await tx.payment.update({
                where: { id: paymentId },
                data: {
                    status: PaymentStatus.WAIVED,
                },
            });

            await tx.branch.update({
                where: { id: payment.branchId },
                data: { lastDataChange: new Date() }
            });

            // Create Audit Log
            await tx.auditLog.create({
                data: {
                    branchId: payment.branchId,
                    userId,
                    action: "PAYMENT_WAIVED",
                    paymentId: payment.id,
                    details: {
                        from: payment.status,
                        to: "WAIVED",
                        amount: payment.amount
                    }
                }
            });

            return updatedPayment;
        });
    }
}
