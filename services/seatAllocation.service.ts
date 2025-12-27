import { prisma } from "@/lib/prisma";
import { StudentStatus } from "@prisma/client";

export class SeatAllocationService {
    /**
     * Assign a seat to a student for a specific shift.
     * STRICT Validation Rules:
     * 1. Student must be ACTIVE.
     * 2. Seat, Student, Shift must belong to the same branch.
     * 3. One seat can have only ONE active allocation per shift.
     */
    /**
     * Assign a seat to a student for a specific shift.
     * STRICT Validation Rules:
     * 1. User must OWN the branch (via seat).
     * 2. Student must be ACTIVE.
     * 3. Seat, Student, Shift must belong to the same branch.
     * 4. One seat can have only ONE active allocation per shift.
     */
    static async assignSeat(
        userId: string,
        seatId: string,
        studentId: string,
        shiftId: string
    ) {
        return prisma.$transaction(async (tx) => {
            // 1. Fetch entities
            const seat = await tx.seat.findUnique({
                where: { id: seatId },
                include: { branch: { include: { organization: true } } }
            });
            const student = await tx.student.findUnique({ where: { id: studentId } });
            const shift = await tx.shift.findUnique({ where: { id: shiftId } });

            if (!seat) throw new Error("Seat not found");
            if (!student) throw new Error("Student not found");
            if (!shift) throw new Error("Shift not found");

            // 2. Validate Ownership
            if (seat.branch.organization.ownerId !== userId) {
                throw new Error("Unauthorized: You do not own this seat's branch");
            }

            const branchId = seat.branchId;

            // 3. Validate "Same Branch" Rule
            if (
                student.branchId !== branchId ||
                shift.branchId !== branchId
            ) {
                throw new Error("Seat, Student, and Shift must belong to the same branch");
            }

            // 4. Validate "Student must be ACTIVE" Rule
            if (student.status !== StudentStatus.ACTIVE) {
                throw new Error("Only ACTIVE students can be assigned a seat");
            }

            // 5. Validate "Single active allocation per seat per shift" Rule
            const existingAllocation = await tx.seatAllocation.findFirst({
                where: {
                    seatId,
                    shiftId,
                    endDate: null, // Active allocation
                },
            });

            if (existingAllocation) {
                throw new Error("Seat is already assigned in this shift");
            }

            // 6. Create Allocation
            return tx.seatAllocation.create({
                data: {
                    seatId,
                    studentId,
                    shiftId,
                },
            });
        });
    }

    /**
     * Unassign (Release) a seat.
     * Sets the endDate to now, marking it as inactive (history).
     * Does NOT delete the record.
     */
    static async unassignSeat(allocationId: string) {
        return prisma.seatAllocation.update({
            where: { id: allocationId },
            data: {
                endDate: new Date(),
            },
        });
    }

    /**
     * List allocations for a branch with optional filters.
     */
    static async listAllocations(
        branchId: string,
        filters?: {
            studentId?: string;
            shiftId?: string;
            activeOnly?: boolean;
        }
    ) {
        return prisma.seatAllocation.findMany({
            where: {
                seat: { branchId }, // Ensure we strictly scope to branch via seat
                studentId: filters?.studentId,
                shiftId: filters?.shiftId,
                endDate: filters?.activeOnly ? null : undefined,
            },
            include: {
                seat: true,
                student: true,
                shift: true,
            },
            orderBy: {
                startDate: "desc",
            },
        });
    }
}
