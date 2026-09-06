import { AccessPolicy } from "@/services/accessPolicy.service";
import { prisma } from "@/lib/prisma";
import { MESSAGE_DRAFT_ACTION_PREFIX } from "@/lib/messageDrafts";
import { StaffService } from "@/services/staff.service";
import {
    PaymentMethod,
    PaymentResolutionEventSource,
    PaymentStatus,
    PaymentType,
    StudentStatus,
} from "@/types";
import type { StaffAction } from "@/types";
import type { Prisma } from "@/app/generated/prisma/client";
import { startOfDay, startOfMonth, endOfMonth } from "date-fns";
import { dueCyclesThrough } from "@/utils/studentBillingCycles";
import { EntitlementService } from "@/services/entitlement.service";
import {
    recordPaymentResolutionEvent,
    type PaymentResolutionContext,
} from "@/services/paymentResolutionEvent.service";
import {
    DEFAULT_PAGE_SIZE,
    pageFromRows,
    type DateIdCursor,
} from "@/lib/cursorPagination";
import type { PagedResult } from "@/types/ui";
import {
    isWhatsAppDeliverySchemaAccessEnabled,
} from "@/lib/whatsappFeature";
import { isWhatsAppDeliverySchemaReady } from "@/lib/whatsappSchema";
import { WhatsAppPaymentReconciliationService } from "@/services/whatsappPaymentReconciliation.service";

const PAYMENT_LIST_INCLUDE = {
    student: {
        select: {
            id: true,
            name: true,
            phone: true,
            joinedAt: true,
        },
    },
} satisfies Prisma.PaymentInclude;

type PaymentListRecord = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_LIST_INCLUDE }>;
type PaymentListPagination = { cursor?: DateIdCursor | null; limit: number };
type EnsureMonthlyPaymentInput = {
    studentId: string;
    periodStart: Date;
    periodEnd: Date;
    dueDate?: Date;
    amount?: number;
    /** Import execution uses this to fence an immutable reviewed cycle. */
    strictExisting?: {
        targetStatus: PaymentStatus;
        paymentMethod?: PaymentMethod;
        referenceId?: string;
    };
};

const STUDENT_GENERATION_BATCH_SIZE = 250;
const PAYMENT_INSERT_BATCH_SIZE = 1000;
const PAYMENT_ACTION_RESOLUTION = {
    source: PaymentResolutionEventSource.PAYMENT_ACTION,
} satisfies PaymentResolutionContext;

async function whatsappDeliveryStateMayExist(
    client: Pick<Prisma.TransactionClient, "$queryRaw">,
    env: Readonly<Record<string, string | undefined>> = process.env
) {
    return isWhatsAppDeliverySchemaAccessEnabled(env)
        || await isWhatsAppDeliverySchemaReady(client);
}

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
    static async assertBranchAccess(userId: string, branchId: string, action: StaffAction) {
        await StaffService.authorize(userId, branchId, action);

        const branch = await prisma.branch.findUnique({ where: { id: branchId } });

        if (!branch) {
            throw new Error("Branch not found");
        }

        return branch;
    }

    private static async loadAuthorizedPaymentForResolution(
        userId: string,
        paymentId: string,
        action: StaffAction,
        tx: Prisma.TransactionClient
    ) {
        const initiallyResolved = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!initiallyResolved) throw new Error("Payment not found");

        await this.authorizePaymentResolution(
            userId,
            initiallyResolved.branchId,
            action,
            tx
        );
        await EntitlementService.assertBranchWritable(initiallyResolved.branchId, tx);

        await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE
        `;
        const payment = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!payment) throw new Error("Payment not found");

        if (payment.branchId !== initiallyResolved.branchId) {
            await this.authorizePaymentResolution(userId, payment.branchId, action, tx);
            await EntitlementService.assertBranchWritable(payment.branchId, tx);
        }

        return payment;
    }

    private static async authorizePaymentResolution(
        userId: string,
        branchId: string,
        action: StaffAction,
        tx: Prisma.TransactionClient
    ) {
        try {
            await AccessPolicy.authorizeRecord(userId, branchId, action, "Payment", tx);
        } catch (error) {
            if (
                error instanceof Error
                && error.message.includes("Not a staff member of this branch")
            ) {
                throw new Error("Payment not found");
            }
            throw error;
        }
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
        await EntitlementService.assertBranchWritable(branchId);
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
        data: EnsureMonthlyPaymentInput
    ) {
        return prisma.$transaction(tx =>
            this.ensureMonthlyPaymentForStudentInTransaction(userId, branchId, data, tx)
        );
    }

    static async ensureMonthlyPaymentForStudentInTransaction(
        userId: string,
        branchId: string,
        data: EnsureMonthlyPaymentInput,
        tx: Prisma.TransactionClient
    ) {
        await AccessPolicy.authorizeAction(userId, branchId, "generate_payments", tx, true);

        const periodStart = startOfDay(data.periodStart);
        const periodEnd = startOfDay(data.periodEnd);
        const dueDate = startOfDay(data.dueDate ?? data.periodEnd);

        const student = await tx.student.findUnique({
            where: { id: data.studentId },
            select: { id: true, branchId: true, monthlyFee: true, status: true },
        });

        if (!student) throw new Error("Student not found");
        if (student.branchId !== branchId) throw new Error("Student does not belong to this branch");
        if (student.status !== StudentStatus.ACTIVE) throw new Error("Only ACTIVE students can receive monthly payments");

        const existing = await tx.payment.findUnique({
            where: {
                studentId_type_periodStart: {
                    studentId: student.id,
                    type: PaymentType.MONTHLY,
                    periodStart,
                },
            },
        });

        if (existing && data.strictExisting) {
            const expectedAmount = data.amount ?? student.monthlyFee;
            const allowedStatuses: PaymentStatus[] = data.strictExisting.targetStatus === PaymentStatus.DUE
                ? [PaymentStatus.DUE]
                : data.strictExisting.targetStatus === PaymentStatus.PAID
                    ? [PaymentStatus.DUE, PaymentStatus.PAID]
                    : [PaymentStatus.DUE, PaymentStatus.WAIVED];
            const existingMethod = existing.paymentMethod ?? undefined;
            const existingReference = existing.referenceId ?? undefined;
            const expectedMethod = data.strictExisting.paymentMethod;
            const expectedReference = data.strictExisting.referenceId;
            const finalMetadataMatches = existing.status === PaymentStatus.DUE
                ? existingMethod === undefined && existingReference === undefined
                : existing.status !== data.strictExisting.targetStatus
                    || (existingMethod === expectedMethod && existingReference === expectedReference);
            if (
                existing.branchId !== branchId
                || existing.type !== PaymentType.MONTHLY
                || existing.amount !== expectedAmount
                || existing.periodEnd.getTime() !== periodEnd.getTime()
                || existing.dueDate.getTime() !== dueDate.getTime()
                || !allowedStatuses.includes(existing.status)
                || !finalMetadataMatches
            ) {
                throw new Error("Import plan is stale because an existing payment does not match the reviewed cycle");
            }
        }

        if (existing) return existing;

        const payment = await tx.payment.create({
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

        await tx.branch.update({
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
        status: PaymentStatus | undefined,
        month: Date | undefined,
        pagination: PaymentListPagination
    ): Promise<PagedResult<PaymentListRecord>>;
    static async listPayments(
        userId: string,
        branchId: string,
        status?: PaymentStatus,
        month?: Date
    ): Promise<PaymentListRecord[]>;
    static async listPayments(
        userId: string,
        branchId: string,
        status?: PaymentStatus,
        month?: Date,
        pagination?: PaymentListPagination
    ): Promise<PagedResult<PaymentListRecord> | PaymentListRecord[]> {
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

        if (!pagination) {
            return prisma.payment.findMany({
                where: whereClause,
                include: PAYMENT_LIST_INCLUDE,
                orderBy: [
                    { dueDate: "asc" },
                    { id: "asc" },
                ],
            });
        }

        const cursorWhere: Prisma.PaymentWhereInput | undefined = pagination.cursor
            ? {
                OR: [
                    { dueDate: { gt: pagination.cursor.sort } },
                    {
                        dueDate: pagination.cursor.sort,
                        id: { gt: pagination.cursor.id },
                    },
                ],
            }
            : undefined;

        const limit = pagination.limit ?? DEFAULT_PAGE_SIZE;

        const [rows, total] = await Promise.all([
            prisma.payment.findMany({
                where: cursorWhere ? { AND: [whereClause, cursorWhere] } : whereClause,
                include: PAYMENT_LIST_INCLUDE,
                orderBy: [
                    { dueDate: "asc" },
                    { id: "asc" },
                ],
                take: limit + 1,
            }),
            prisma.payment.count({ where: whereClause }),
        ]);

        return pageFromRows(rows, limit, total, payment => ({
            sort: payment.dueDate,
            id: payment.id,
        }));
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
        return prisma.$transaction(tx =>
            this.markPaymentAsPaidInTransaction(
                userId,
                paymentId,
                method,
                referenceId,
                tx,
                PAYMENT_ACTION_RESOLUTION
            )
        );
    }

    static async markPaymentAsPaidInTransaction(
        userId: string,
        paymentId: string,
        method: PaymentMethod | undefined,
        referenceId: string | undefined,
        tx: Prisma.TransactionClient,
        resolutionContext: PaymentResolutionContext
    ) {
        const payment = await this.loadAuthorizedPaymentForResolution(
            userId,
            paymentId,
            "mark_payment_paid",
            tx
        );
        if (payment.status === PaymentStatus.PAID) return payment;
        const transitionAt = new Date();

        const updatedPayment = await tx.payment.update({
            where: { id: paymentId },
            data: {
                status: PaymentStatus.PAID,
                paidAt: transitionAt,
                ...(method ? { paymentMethod: method } : {}),
                ...(referenceId ? { referenceId } : {}),
            },
        });

        await tx.messageDraft.deleteMany({
            where: {
                studentId: payment.studentId,
                branchId: payment.branchId,
                action: { startsWith: MESSAGE_DRAFT_ACTION_PREFIX },
            },
        });

        await tx.branch.update({
            where: { id: payment.branchId },
            data: { lastDataChange: transitionAt },
        });

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
            },
        });

        await recordPaymentResolutionEvent(tx, {
            before: payment,
            after: updatedPayment,
            actorUserId: userId,
            occurredAt: transitionAt,
            ...resolutionContext,
        });

        // This remains a local outbox reconciliation inside the payment
        // transaction. It never calls Meta. The schema-access fence only avoids
        // PR3 table access before the database-first expansion has been deployed.
        if (await whatsappDeliveryStateMayExist(tx)) {
            await WhatsAppPaymentReconciliationService.reconcileResolutionInTransaction({
                tx,
                branchId: payment.branchId,
                paymentId: payment.id,
                reason: "PAYMENT_RESOLVED",
                now: transitionAt,
            });
        }

        return updatedPayment;
    }

    /**
     * Marks a payment as WAIVED.
     * WAIVED = owner consciously decided not to pursue this debt.
     * Preserves history; excluded from overdue/due analytics.
     */
    static async markPaymentAsWaived(
        userId: string,
        paymentId: string
    ) {
        return prisma.$transaction(tx =>
            this.markPaymentAsWaivedInTransaction(
                userId,
                paymentId,
                tx,
                PAYMENT_ACTION_RESOLUTION
            )
        );
    }

    static async markPaymentAsWaivedInTransaction(
        userId: string,
        paymentId: string,
        tx: Prisma.TransactionClient,
        resolutionContext: PaymentResolutionContext
    ) {
        const payment = await this.loadAuthorizedPaymentForResolution(
            userId,
            paymentId,
            "waive_payments",
            tx
        );
        if (payment.status === PaymentStatus.WAIVED) return payment;
        const transitionAt = new Date();

        const updatedPayment = await tx.payment.update({
            where: { id: paymentId },
            data: {
                status: PaymentStatus.WAIVED,
            },
        });

        await tx.branch.update({
            where: { id: payment.branchId },
            data: { lastDataChange: transitionAt },
        });

        await tx.auditLog.create({
            data: {
                branchId: payment.branchId,
                userId,
                action: "PAYMENT_WAIVED",
                paymentId: payment.id,
                details: {
                    from: payment.status,
                    to: "WAIVED",
                    amount: payment.amount,
                },
            },
        });

        await recordPaymentResolutionEvent(tx, {
            before: payment,
            after: updatedPayment,
            actorUserId: userId,
            occurredAt: transitionAt,
            ...resolutionContext,
        });

        if (await whatsappDeliveryStateMayExist(tx)) {
            await WhatsAppPaymentReconciliationService.reconcileResolutionInTransaction({
                tx,
                branchId: payment.branchId,
                paymentId: payment.id,
                reason: payment.status === PaymentStatus.PAID
                    ? "PAYMENT_CONFIRMATION_CORRECTED"
                    : "PAYMENT_RESOLVED",
                now: transitionAt,
            });
        }

        return updatedPayment;
    }
}
