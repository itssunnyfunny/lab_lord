import { prisma } from "@/lib/prisma";
import { StudentStatus, PaymentType, PaymentStatus, isDueResolution } from "@/types";
import type { CreateImportedStudentDto, CreateStudentDto, DueResolution, UpdateStudentProfileDto } from "@/types";
import { SeatAllocationService } from "@/services/seatAllocation.service";
import { StaffService } from "@/services/staff.service";
import { startOfDay } from "date-fns";
import type { Prisma } from "@/app/generated/prisma/client";
import { EntitlementService } from "@/services/entitlement.service";
import {
    compactText,
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalId,
    validatePhone,
    validateRequiredPhone,
    validateRequiredText,
} from "@/lib/formValidation";
import {
    DEFAULT_PAGE_SIZE,
    pageFromRows,
    type DateIdCursor,
} from "@/lib/cursorPagination";
import type { PagedResult } from "@/types/ui";

const STUDENT_LIST_INCLUDE = {
    seatAllocations: {
        where: { endDate: null },
        include: {
            seat: {
                select: {
                    id: true,
                    label: true,
                },
            },
            shift: {
                select: {
                    id: true,
                    name: true,
                    startTime: true,
                    endTime: true,
                },
            },
            multiShift: {
                select: {
                    id: true,
                    name: true,
                },
            },
        },
        orderBy: {
            startDate: "desc" as const,
        },
    },
} satisfies Prisma.StudentInclude;

type StudentListRecord = Prisma.StudentGetPayload<{ include: typeof STUDENT_LIST_INCLUDE }>;
type StudentListFilters = {
    status?: StudentStatus;
    shiftId?: string;
    query?: string;
    cursor?: DateIdCursor | null;
    limit?: number;
};

function assertNever(value: never): never {
    throw new Error(`Unexpected due resolution: ${String(value)}`);
}

export class StudentService {
    /**
     * Helper to verify that the user can work with students in the branch.
     */
    private static async verifyBranchAccess(userId: string, branchId: string) {
        await StaffService.authorize(userId, branchId, "students");

        const branch = await prisma.branch.findUnique({ where: { id: branchId } });

        if (!branch) {
            throw new Error("Branch not found");
        }

        return branch;
    }

    /**
     * Helper to verify that the user can work with a student in its branch.
     */
    private static async verifyStudentAccess(userId: string, studentId: string) {
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { branch: true },
        });

        if (!student) {
            throw new Error("Student not found");
        }

        await StaffService.authorize(userId, student.branchId, "students");

        return student;
    }

    private static async resolveMonthlyFeeData(
        tx: Prisma.TransactionClient,
        branchId: string,
        data: {
            monthlyFee?: number;
            feeLinkedShiftId?: string | null;
            feeLinkedMultiShiftId?: string | null;
        },
        fallbackMonthlyFee: number
    ) {
        const feeLinkedShiftId = data.feeLinkedShiftId ?? null;
        const feeLinkedMultiShiftId = data.feeLinkedMultiShiftId ?? null;

        if (feeLinkedShiftId && feeLinkedMultiShiftId) {
            throw new Error("Fee can be linked to either a shift or a multi-shift, not both.");
        }

        if (feeLinkedShiftId) {
            const shift = await tx.shift.findUnique({
                where: { id: feeLinkedShiftId },
                select: { branchId: true, price: true, status: true },
            });
            if (!shift || shift.branchId !== branchId || shift.status !== "ACTIVE") {
                throw new Error("Linked shift not found in this branch.");
            }

            return {
                monthlyFee: shift.price,
                feeLinkedShiftId,
                feeLinkedMultiShiftId: null,
            };
        }

        if (feeLinkedMultiShiftId) {
            const multiShift = await tx.multiShift.findUnique({
                where: { id: feeLinkedMultiShiftId },
                select: { branchId: true, price: true },
            });
            if (!multiShift || multiShift.branchId !== branchId) {
                throw new Error("Linked multi-shift not found in this branch.");
            }

            return {
                monthlyFee: multiShift.price,
                feeLinkedShiftId: null,
                feeLinkedMultiShiftId,
            };
        }

        return {
            monthlyFee: data.monthlyFee ?? fallbackMonthlyFee,
            feeLinkedShiftId: null,
            feeLinkedMultiShiftId: null,
        };
    }

    private static studentNameKey(name: string) {
        return compactText(name).toLocaleLowerCase("en-IN");
    }

    private static studentPhoneKey(phone: string | null) {
        const result = validatePhone(phone);
        if (result.ok) return result.value ?? "";
        return compactText(phone);
    }

    private static async assertUniqueBranchIdentity(
        tx: Prisma.TransactionClient,
        branchId: string,
        name: string,
        phone: string,
        excludeStudentId?: string
    ) {
        const nameKey = this.studentNameKey(name);
        const phoneKey = this.studentPhoneKey(phone);
        const existingStudents = await tx.student.findMany({
            where: {
                branchId,
                ...(excludeStudentId ? { id: { not: excludeStudentId } } : {}),
            },
            select: {
                name: true,
                phone: true,
            },
        });

        const duplicate = existingStudents.some(student =>
            this.studentNameKey(student.name) === nameKey &&
            this.studentPhoneKey(student.phone) === phoneKey
        );

        if (duplicate) {
            throw new Error("A student with this name and phone number already exists in this branch.");
        }
    }

    static async createStudent(
        userId: string,
        branchId: string,
        data: CreateStudentDto
    ) {
        const branch = await this.verifyBranchAccess(userId, branchId);
        await EntitlementService.assertBranchWritable(branchId);
        const nameResult = validateRequiredText(data.name, "Student name");
        if (!nameResult.ok) throw new Error(nameResult.error);
        const phoneResult = validateRequiredPhone(data.phone);
        if (!phoneResult.ok) throw new Error(phoneResult.error);
        const monthlyFeeResult = parseIntegerField(data.monthlyFee, "Monthly fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!monthlyFeeResult.ok) throw new Error(monthlyFeeResult.error);
        const admissionFeeResult = parseIntegerField(data.admissionFee, "Admission fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!admissionFeeResult.ok) throw new Error(admissionFeeResult.error);
        const linkedShiftResult = validateOptionalId(data.feeLinkedShiftId, "Linked shift");
        if (!linkedShiftResult.ok) throw new Error(linkedShiftResult.error);
        const linkedMultiShiftResult = validateOptionalId(data.feeLinkedMultiShiftId, "Linked multi-shift");
        if (!linkedMultiShiftResult.ok) throw new Error(linkedMultiShiftResult.error);

        // Normalise shiftId (legacy singular) → shiftIds (new array)
        const shiftIds: string[] = data.shiftIds && data.shiftIds.length > 0
            ? data.shiftIds
            : data.shiftId
                ? [data.shiftId]
                : [];

        // 1. Create student + admission payment in one transaction
        const student = await prisma.$transaction(async (tx) => {
            await this.assertUniqueBranchIdentity(tx, branchId, nameResult.value, phoneResult.value);

            const feeData = await this.resolveMonthlyFeeData(
                tx,
                branchId,
                {
                    monthlyFee: monthlyFeeResult.value,
                    feeLinkedShiftId: linkedShiftResult.value,
                    feeLinkedMultiShiftId: linkedMultiShiftResult.value,
                },
                monthlyFeeResult.value ?? branch.defaultFee ?? 0
            );

            const created = await tx.student.create({
                data: {
                    branchId,
                    name: nameResult.value,
                    phone: phoneResult.value,
                    status: StudentStatus.ACTIVE,
                    monthlyFee: feeData.monthlyFee,
                    feeLinkedShiftId: feeData.feeLinkedShiftId,
                    feeLinkedMultiShiftId: feeData.feeLinkedMultiShiftId,
                    joinedAt: new Date(),
                },
            });

            const admissionFee = admissionFeeResult.value ?? branch.defaultAdmissionFee ?? 0;
            if (admissionFee > 0) {
                await tx.payment.create({
                    data: {
                        branchId,
                        studentId: created.id,
                        amount: admissionFee,
                        status: PaymentStatus.DUE,
                        type: PaymentType.ADMISSION,
                        // Normalize to midnight so it never collides with a MONTHLY
                        // payment's periodStart (which is also normalized via startOfDay)
                        dueDate:     startOfDay(created.joinedAt),
                        periodStart: startOfDay(created.joinedAt),
                        periodEnd:   startOfDay(created.joinedAt),
                    },
                });
            }

            await tx.branch.update({
                where: { id: branchId },
                data: { lastDataChange: new Date() },
            });

            return created;
        });

        // 2. If seat + shifts provided, assign via SeatAllocationService
        //    (runs its own transaction with full cross-shift conflict checks)
        if (data.seatId && shiftIds.length > 0) {
            await SeatAllocationService.assignSeatToShifts(
                userId,
                data.seatId,
                student.id,
                shiftIds
            );
        }

        return student;
    }

    static async createImportedStudent(
        userId: string,
        branchId: string,
        data: CreateImportedStudentDto
    ) {
        const branch = await this.verifyBranchAccess(userId, branchId);
        await EntitlementService.assertBranchWritable(branchId);
        const nameResult = validateRequiredText(data.name, "Student name");
        if (!nameResult.ok) throw new Error(nameResult.error);
        const phoneResult = validatePhone(data.phone ?? undefined);
        if (!phoneResult.ok) throw new Error(phoneResult.error);
        const monthlyFeeResult = parseIntegerField(data.monthlyFee, "Monthly fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!monthlyFeeResult.ok) throw new Error(monthlyFeeResult.error);
        const admissionFeeResult = parseIntegerField(data.admissionFee, "Admission fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!admissionFeeResult.ok) throw new Error(admissionFeeResult.error);
        const linkedShiftResult = validateOptionalId(data.feeLinkedShiftId, "Linked shift");
        if (!linkedShiftResult.ok) throw new Error(linkedShiftResult.error);
        const linkedMultiShiftResult = validateOptionalId(data.feeLinkedMultiShiftId, "Linked multi-shift");
        if (!linkedMultiShiftResult.ok) throw new Error(linkedMultiShiftResult.error);

        const joinedAt = data.joinedAt instanceof Date && !Number.isNaN(data.joinedAt.getTime())
            ? data.joinedAt
            : new Date();
        const shiftIds = data.shiftIds && data.shiftIds.length > 0 ? data.shiftIds : [];

        const student = await prisma.$transaction(async (tx) => {
            if (phoneResult.value) {
                await this.assertUniqueBranchIdentity(tx, branchId, nameResult.value, phoneResult.value);
            }

            const feeData = await this.resolveMonthlyFeeData(
                tx,
                branchId,
                {
                    monthlyFee: monthlyFeeResult.value,
                    feeLinkedShiftId: linkedShiftResult.value,
                    feeLinkedMultiShiftId: linkedMultiShiftResult.value,
                },
                monthlyFeeResult.value ?? branch.defaultFee ?? 0
            );

            const created = await tx.student.create({
                data: {
                    branchId,
                    name: nameResult.value,
                    phone: phoneResult.value ?? null,
                    status: StudentStatus.ACTIVE,
                    monthlyFee: feeData.monthlyFee,
                    feeLinkedShiftId: feeData.feeLinkedShiftId,
                    feeLinkedMultiShiftId: feeData.feeLinkedMultiShiftId,
                    joinedAt,
                    billingStartAt: data.billingStartAt ?? null,
                },
            });

            const admissionFee = admissionFeeResult.value ?? branch.defaultAdmissionFee ?? 0;
            if (admissionFee > 0) {
                await tx.payment.create({
                    data: {
                        branchId,
                        studentId: created.id,
                        amount: admissionFee,
                        status: PaymentStatus.DUE,
                        type: PaymentType.ADMISSION,
                        dueDate: startOfDay(joinedAt),
                        periodStart: startOfDay(joinedAt),
                        periodEnd: startOfDay(joinedAt),
                    },
                });
            }

            await tx.branch.update({
                where: { id: branchId },
                data: { lastDataChange: new Date() },
            });

            return created;
        });

        if (data.seatId && shiftIds.length > 0) {
            await SeatAllocationService.assignSeatToShifts(
                userId,
                data.seatId,
                student.id,
                shiftIds
            );
        }

        return student;
    }

    static async updateStudentProfile(
        userId: string,
        studentId: string,
        data: UpdateStudentProfileDto
    ) {
        const verifiedStudent = await this.verifyStudentAccess(userId, studentId);
        await EntitlementService.assertBranchWritable(verifiedStudent.branchId);
        const nameResult = data.name !== undefined ? validateRequiredText(data.name, "Student name") : null;
        if (nameResult && !nameResult.ok) throw new Error(nameResult.error);
        const phoneResult = data.phone !== undefined ? validateRequiredPhone(data.phone) : null;
        if (phoneResult && !phoneResult.ok) throw new Error(phoneResult.error);
        const monthlyFeeResult = data.monthlyFee !== undefined
            ? parseIntegerField(data.monthlyFee, "Monthly fee", { min: 0, max: FORM_LIMITS.moneyMax })
            : null;
        if (monthlyFeeResult && !monthlyFeeResult.ok) throw new Error(monthlyFeeResult.error);
        const linkedShiftResult = data.feeLinkedShiftId !== undefined
            ? validateOptionalId(data.feeLinkedShiftId, "Linked shift")
            : null;
        if (linkedShiftResult && !linkedShiftResult.ok) throw new Error(linkedShiftResult.error);
        const linkedMultiShiftResult = data.feeLinkedMultiShiftId !== undefined
            ? validateOptionalId(data.feeLinkedMultiShiftId, "Linked multi-shift")
            : null;
        if (linkedMultiShiftResult && !linkedMultiShiftResult.ok) throw new Error(linkedMultiShiftResult.error);

        return prisma.$transaction(async (tx) => {
            const finalName = nameResult?.ok ? nameResult.value : verifiedStudent.name;
            const finalPhone = phoneResult?.ok ? phoneResult.value : verifiedStudent.phone;
            if ((nameResult || phoneResult) && finalPhone) {
                await this.assertUniqueBranchIdentity(
                    tx,
                    verifiedStudent.branchId,
                    finalName,
                    finalPhone,
                    studentId
                );
            }

            const feeLinkTouched =
                data.feeLinkedShiftId !== undefined ||
                data.feeLinkedMultiShiftId !== undefined;
            const feeManuallyTouched = data.monthlyFee !== undefined;

            let feeData: Partial<{
                monthlyFee: number;
                feeLinkedShiftId: string | null;
                feeLinkedMultiShiftId: string | null;
            }> = {};

            if (feeLinkTouched) {
                feeData = await this.resolveMonthlyFeeData(
                    tx,
                    verifiedStudent.branchId,
                    {
                        monthlyFee: monthlyFeeResult?.value,
                        feeLinkedShiftId: linkedShiftResult?.value ?? null,
                        feeLinkedMultiShiftId: linkedMultiShiftResult?.value ?? null,
                    },
                    verifiedStudent.monthlyFee
                );
            } else if (feeManuallyTouched) {
                feeData = {
                    monthlyFee: monthlyFeeResult?.value ?? verifiedStudent.monthlyFee,
                    feeLinkedShiftId: null,
                    feeLinkedMultiShiftId: null,
                };
            }

            const updated = await tx.student.update({
                where: { id: studentId },
                data: {
                    ...(nameResult?.ok ? { name: nameResult.value } : {}),
                    ...(phoneResult?.ok ? { phone: phoneResult.value ?? null } : {}),
                    ...feeData,
                },
            });

            await tx.branch.update({
                where: { id: verifiedStudent.branchId },
                data: { lastDataChange: new Date() },
            });

            return updated;
        });
    }


    static async getStudentsByBranch(
        userId: string,
        branchId: string,
        filters: StudentListFilters & { limit: number }
    ): Promise<PagedResult<StudentListRecord>>;
    static async getStudentsByBranch(
        userId: string,
        branchId: string,
        filters?: Omit<StudentListFilters, "cursor" | "limit">
    ): Promise<StudentListRecord[]>;
    static async getStudentsByBranch(
        userId: string,
        branchId: string,
        filters?: StudentListFilters
    ): Promise<PagedResult<StudentListRecord> | StudentListRecord[]> {
        await this.verifyBranchAccess(userId, branchId);

        const query = filters?.query?.trim();
        const baseWhere: Prisma.StudentWhereInput = {
            branchId,
            ...(filters?.status ? { status: filters.status } : {}),
            ...(filters?.shiftId
                ? {
                    seatAllocations: {
                        some: {
                            shiftId: filters.shiftId,
                            endDate: null,
                        },
                    },
                }
                : {}),
            ...(query
                ? {
                    OR: [
                        { name: { contains: query, mode: "insensitive" } },
                        { phone: { contains: query } },
                    ],
                }
                : {}),
        };
        const cursorWhere: Prisma.StudentWhereInput | undefined = filters?.cursor
            ? {
                OR: [
                    { createdAt: { lt: filters.cursor.sort } },
                    {
                        createdAt: filters.cursor.sort,
                        id: { lt: filters.cursor.id },
                    },
                ],
            }
            : undefined;

        if (filters?.limit === undefined) {
            return prisma.student.findMany({
                where: baseWhere,
                include: STUDENT_LIST_INCLUDE,
                orderBy: [
                    { name: "asc" },
                    { id: "asc" },
                ],
            });
        }

        const limit = filters.limit ?? DEFAULT_PAGE_SIZE;

        const [rows, total] = await Promise.all([
            prisma.student.findMany({
                where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
                include: STUDENT_LIST_INCLUDE,
                orderBy: [
                    { createdAt: "desc" },
                    { id: "desc" },
                ],
                take: limit + 1,
            }),
            prisma.student.count({ where: baseWhere }),
        ]);

        return pageFromRows(rows, limit, total, student => ({
            sort: student.createdAt,
            id: student.id,
        }));
    }

    /**
     * Updates student status.
     *
     * When INACTIVATING:
     * 1. Ends all active seat allocations (sets endDate = now)
     * 2. Resolves DUE payments based on dueResolution:
     *    - PAID  → marks as PAID with paidAt = now
     *    - WAIVED → marks as WAIVED
     *    - KEEP (default) → leaves DUE payments untouched
     *
     * When ACTIVATING: simply sets status = ACTIVE.
     */
    static async updateStudentStatus(
        userId: string,
        studentId: string,
        status: StudentStatus,
        dueResolution: DueResolution = "KEEP"
    ) {
        if (!isDueResolution(dueResolution)) {
            throw new Error("Invalid due resolution");
        }

        const verifiedStudent = await this.verifyStudentAccess(userId, studentId);
        await EntitlementService.assertBranchWritable(verifiedStudent.branchId);
        const now = new Date();

        let paymentResolution: {
            status: PaymentStatus;
            action: "PAYMENT_MARKED_PAID" | "PAYMENT_WAIVED";
            data: {
                status: PaymentStatus;
                paidAt?: Date;
            };
        } | null = null;

        if (status === StudentStatus.INACTIVE) {
            switch (dueResolution) {
                case "KEEP":
                    break;
                case "PAID":
                    await StaffService.authorize(userId, verifiedStudent.branchId, "mark_payment_paid");
                    paymentResolution = {
                        status: PaymentStatus.PAID,
                        action: "PAYMENT_MARKED_PAID",
                        data: {
                            status: PaymentStatus.PAID,
                            paidAt: now,
                        },
                    };
                    break;
                case "WAIVED":
                    await StaffService.authorize(userId, verifiedStudent.branchId, "waive_payments");
                    paymentResolution = {
                        status: PaymentStatus.WAIVED,
                        action: "PAYMENT_WAIVED",
                        data: {
                            status: PaymentStatus.WAIVED,
                        },
                    };
                    break;
                default:
                    assertNever(dueResolution);
            }
        }

        return prisma.$transaction(async (tx) => {
            // 1. Update student status
            const student = await tx.student.update({
                where: { id: studentId },
                data: { status },
            });

            if (status === StudentStatus.INACTIVE) {
                // 2. End all active seat allocations
                await tx.seatAllocation.updateMany({
                    where: {
                        studentId,
                        endDate: null,
                    },
                    data: {
                        endDate: now,
                    },
                });

                const paymentsToResolve: {
                    id: string;
                    branchId: string;
                    amount: number;
                    status: PaymentStatus;
                }[] = paymentResolution === null
                    ? []
                    : await tx.payment.findMany({
                        where: {
                            studentId,
                            status: PaymentStatus.DUE,
                        },
                        select: {
                            id: true,
                            branchId: true,
                            amount: true,
                            status: true,
                        },
                    });

                // 3. Resolve DUE payments based on the validated choice
                if (paymentResolution) {
                    await tx.payment.updateMany({
                        where: {
                            studentId,
                            status: PaymentStatus.DUE,
                        },
                        data: paymentResolution.data,
                    });
                }
                // KEEP: do nothing, DUE payments stay as-is

                if (paymentsToResolve.length > 0 && paymentResolution) {
                    await tx.auditLog.createMany({
                        data: paymentsToResolve.map(payment => ({
                            branchId: payment.branchId,
                            userId,
                            action: paymentResolution.action,
                            paymentId: payment.id,
                            details: {
                                from: payment.status,
                                to: paymentResolution.status,
                                amount: payment.amount,
                                ...(paymentResolution.status === PaymentStatus.PAID
                                    ? { method: null, referenceId: null }
                                    : {}),
                            },
                        })),
                    });
                }
            }

            // 4. Update Branch lastDataChange
            await tx.branch.update({
                where: { id: verifiedStudent.branch.id },
                data: { lastDataChange: now },
            });

            return student;
        });
    }
}
