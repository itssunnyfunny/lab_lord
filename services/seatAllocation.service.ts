import { prisma } from "@/lib/prisma";
import { StaffService } from "@/services/staff.service";
import { StudentStatus, SeatAllocationFilters } from "@/types";
import type { Prisma, SeatAllocation } from "@/app/generated/prisma/client";
import { parseNullableTime, timesOverlap } from "@/utils/shiftTime";
import { EntitlementService } from "@/services/entitlement.service";
import {
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    pageFromRows,
    PaginationInputError,
    type DateIdCursor,
} from "@/lib/cursorPagination";

export type SeatAllocationListOptions = {
    cursor?: DateIdCursor | null;
    limit?: number;
    all?: boolean;
};

export class SeatAllocationService {
    private static async getSeatBranchId(seatId: string) {
        const seat = await prisma.seat.findUnique({
            where: { id: seatId },
            select: { branchId: true },
        });

        if (!seat) throw new Error("Seat not found");
        return seat.branchId;
    }

    private static async getAllocationWithBranch(allocationId: string) {
        const allocation = await prisma.seatAllocation.findUnique({
            where: { id: allocationId },
            include: { seat: { select: { branchId: true } } },
        });

        if (!allocation) throw new Error("Allocation not found");
        return allocation;
    }

    /**
     * Assign a seat to a student across ONE OR MORE shifts atomically.
     *
     * STRICT Validation Rules (enforced inside a single transaction):
     * 1. User must have seat-allocation access in the branch.
     * 2. Student must be ACTIVE.
     * 3. Seat, Student, and ALL Shifts must belong to the same branch.
     * 4. Requested shifts must not overlap with each other.
     * 5. Seat cannot be occupied in any time-overlapping shift.
     * 6. Student cannot already be allocated in any time-overlapping shift.
     * 7. Shift must be ACTIVE.
     *
     * Returns an array of created SeatAllocation records (one per shift).
     */
    static async assignSeatToShifts(
        userId: string,
        seatId: string,
        studentId: string,
        shiftIds: string[],
        multiShiftId?: string
    ) {
        if (!shiftIds || shiftIds.length === 0) {
            throw new Error("At least one shift must be selected.");
        }

        // Deduplicate
        const uniqueShiftIds = [...new Set(shiftIds)];
        const authorizedBranchId = await this.getSeatBranchId(seatId);
        await StaffService.authorize(userId, authorizedBranchId, "seat_allocation");
        await EntitlementService.assertBranchWritable(authorizedBranchId);

        return prisma.$transaction(async (tx) => {
            // 1. Fetch seat and resolve branch scope
            const seat = await tx.seat.findUnique({
                where: { id: seatId },
            });
            if (!seat) throw new Error("Seat not found");

            const branchId = seat.branchId;

            // 3. Fetch student
            const student = await tx.student.findUnique({ where: { id: studentId } });
            if (!student) throw new Error("Student not found");
            if (student.status !== StudentStatus.ACTIVE) {
                throw new Error("Only ACTIVE students can be assigned a seat");
            }
            if (student.branchId !== branchId) {
                throw new Error("Student does not belong to this branch");
            }

            // 3b. Validate multiShiftId if provided
            if (multiShiftId) {
                const ms = await tx.multiShift.findUnique({
                    where: { id: multiShiftId },
                    include: { components: { select: { shiftId: true } } },
                });
                if (!ms) throw new Error("Multi-shift not found");
                if (ms.branchId !== branchId) throw new Error("Multi-shift does not belong to this branch");
                const componentIds = ms.components.map(component => component.shiftId);
                if (
                    componentIds.length !== uniqueShiftIds.length
                    || componentIds.some(componentId => !uniqueShiftIds.includes(componentId))
                ) {
                    throw new Error("All component shifts of the selected multi-shift are required.");
                }
            }

            // 4. Fetch and validate all requested shifts
            const requestedShifts = await tx.shift.findMany({
                where: { id: { in: uniqueShiftIds } },
            });

            if (requestedShifts.length !== uniqueShiftIds.length) {
                throw new Error("One or more shifts were not found.");
            }

            for (const s of requestedShifts) {
                if (s.status !== "ACTIVE") throw new Error(`Shift "${s.name}" is not active.`);
                if (s.branchId !== branchId) throw new Error(`Shift "${s.name}" does not belong to this branch.`);
            }

            // 5. Requested shifts must not overlap with each other.
            //    EXCEPTION: when allocating via a multi-shift (multiShiftId is set),
            //    the component shifts are a pre-approved bundle — skip this check.
            //    The overlap guard still protects manual multi-primary-shift selections.
            if (!multiShiftId) {
                for (let i = 0; i < requestedShifts.length; i++) {
                    for (let j = i + 1; j < requestedShifts.length; j++) {
                        const a = requestedShifts[i];
                        const b = requestedShifts[j];
                        if (timesOverlap(
                            parseNullableTime(a.startTime),
                            parseNullableTime(a.endTime),
                            parseNullableTime(b.startTime),
                            parseNullableTime(b.endTime)
                        )) {
                            throw new Error(
                                `Selected shifts "${a.name}" and "${b.name}" overlap with each other. You cannot assign both.`
                            );
                        }
                    }
                }
            }

            // 6. Load ALL active shifts in branch for conflict lookups
            const allBranchShifts = await tx.shift.findMany({
                where: { branchId, status: "ACTIVE" },
                select: { id: true, name: true, startTime: true, endTime: true },
            });
            const shiftTimeMap = new Map(allBranchShifts.map(s => [s.id, s]));

            // 7. Load existing active seat allocations (for seat + student conflict checks)
            const activeSeatAllocations = await tx.seatAllocation.findMany({
                where: { seatId, endDate: null },
            });
            const activeStudentAllocations = await tx.seatAllocation.findMany({
                where: { studentId, endDate: null },
            });

            const allocationsToCreate = [];

            for (const requestedShift of requestedShifts) {
                const newStart = parseNullableTime(requestedShift.startTime);
                const newEnd = parseNullableTime(requestedShift.endTime);

                // 7a. Seat conflict — block if seat occupied in exact or time-overlapping shift
                for (const alloc of activeSeatAllocations) {
                    if (alloc.shiftId === requestedShift.id) {
                        throw new Error(`Seat is already assigned in shift "${requestedShift.name}".`);
                    }
                    const existing = shiftTimeMap.get(alloc.shiftId);
                    if (existing && timesOverlap(newStart, newEnd, parseNullableTime(existing.startTime), parseNullableTime(existing.endTime))) {
                        throw new Error(
                            `Seat is already occupied during this time (conflict with "${existing.name}")`
                        );
                    }
                }

                // 7b. Student conflict — block if student already in exact or time-overlapping shift
                for (const alloc of activeStudentAllocations) {
                    if (alloc.shiftId === requestedShift.id) {
                        throw new Error(`Student already has a seat in shift "${requestedShift.name}".`);
                    }
                    const existing = shiftTimeMap.get(alloc.shiftId);
                    if (existing && timesOverlap(newStart, newEnd, parseNullableTime(existing.startTime), parseNullableTime(existing.endTime))) {
                        throw new Error(
                            `Student is already allocated in an overlapping shift ("${existing.name}")`
                        );
                    }
                }

                // 8. Create allocation for this shift (with optional multiShiftId)
                const allocation = await tx.seatAllocation.create({
                    data: {
                        seatId,
                        studentId,
                        shiftId: requestedShift.id,
                        ...(multiShiftId ? { multiShiftId } : {}),
                    },
                });

                // Push mock objects into live arrays so subsequent loop iterations
                // also see allocations created earlier in this transaction.
                const mockAllocation = { shiftId: requestedShift.id } as SeatAllocation;
                activeSeatAllocations.push(mockAllocation);
                activeStudentAllocations.push(mockAllocation);

                allocationsToCreate.push(allocation);
            }

            // 9. Update Branch lastDataChange
            await tx.branch.update({
                where: { id: branchId },
                data: { lastDataChange: new Date() },
            });

            return allocationsToCreate;
        });
    }

    /**
     * Single-shift convenience wrapper — delegates to assignSeatToShifts.
     * Kept for backward compatibility with any internal callers.
     */
    static async assignSeat(
        userId: string,
        seatId: string,
        studentId: string,
        shiftId: string
    ) {
        const results = await this.assignSeatToShifts(userId, seatId, studentId, [shiftId]);
        return results[0];
    }

    /**
     * Unassign (Release) a seat.
     * Sets the endDate to now, marking it as inactive (history).
     * Does NOT delete the record.
     */
    static async unassignSeat(userId: string, allocationId: string) {
        const allocation = await this.getAllocationWithBranch(allocationId);
        await StaffService.authorize(userId, allocation.seat.branchId, "seat_allocation");
        await EntitlementService.assertBranchWritable(allocation.seat.branchId);

        return prisma.$transaction(async (tx) => {
            const scopedAllocation = await tx.seatAllocation.findUnique({
                where: { id: allocationId },
                include: { seat: true },
            });

            if (!scopedAllocation) throw new Error("Allocation not found");
            if (scopedAllocation.endDate !== null) throw new Error("Allocation is already ended.");

            const updatedAllocation = await tx.seatAllocation.update({
                where: { id: allocationId },
                data: { endDate: new Date() },
            });

            await tx.branch.update({
                where: { id: scopedAllocation.seat.branchId },
                data: { lastDataChange: new Date() },
            });

            return updatedAllocation;
        });
    }

    /**
     * Update an active allocation — end old record(s) and create new one(s)
     * atomically. Used for "Change Seat / Shift" from the UI.
     *
     * @param userId        - User performing the action
     * @param allocationIds - IDs of the current active allocation(s) to end
     * @param newSeatId     - Target seat
     * @param newShiftIds   - Target shift(s) (component IDs for multi-shift)
     * @param newMultiShiftId - Optional multi-shift bundle ID
     */
    static async updateAllocation(
        userId: string,
        allocationIds: string[],
        newSeatId: string,
        studentId: string,
        newShiftIds: string[],
        newMultiShiftId?: string
    ) {
        if (allocationIds.length === 0) {
            throw new Error("At least one allocation is required.");
        }

        // Fetch one allocation to get the studentId (validation)
        const existing = await prisma.seatAllocation.findUnique({
            where: { id: allocationIds[0] },
        });
        if (!existing) throw new Error("Allocation not found.");
        if (existing.endDate !== null) throw new Error("Allocation is already ended.");
        if (existing.studentId !== studentId) throw new Error("Student mismatch.");

        const allocationBranch = await this.getAllocationWithBranch(existing.id);
        const branchId = allocationBranch.seat.branchId;
        await StaffService.authorize(userId, branchId, "seat_allocation");
        await EntitlementService.assertBranchWritable(branchId);

        const uniqueAllocationIds = [...new Set(allocationIds)];
        const scopedAllocations = await prisma.seatAllocation.findMany({
            where: { id: { in: uniqueAllocationIds } },
            include: { seat: { select: { branchId: true } } },
        });

        if (scopedAllocations.length !== uniqueAllocationIds.length) {
            throw new Error("One or more allocations were not found.");
        }

        for (const allocation of scopedAllocations) {
            if (allocation.endDate !== null) throw new Error("Allocation is already ended.");
            if (allocation.studentId !== studentId) throw new Error("Student mismatch.");
            if (allocation.seat.branchId !== branchId) {
                throw new Error("Allocations must belong to the same branch.");
            }
        }

        const targetSeat = await prisma.seat.findUnique({
            where: { id: newSeatId },
            select: { branchId: true },
        });
        if (!targetSeat) throw new Error("Seat not found.");
        if (targetSeat.branchId !== branchId) {
            throw new Error("Seat does not belong to this branch.");
        }

        // End all old allocations + create new ones in one transaction
        return prisma.$transaction(async (tx) => {
            // End old records
            await tx.seatAllocation.updateMany({
                where: { id: { in: uniqueAllocationIds }, endDate: null },
                data: { endDate: new Date() },
            });

            // Re-check branch scope inside the write transaction.
            const seat = await tx.seat.findUnique({
                where: { id: newSeatId },
                select: { branchId: true },
            });
            if (!seat) throw new Error("Seat not found.");
            if (seat.branchId !== branchId)
                throw new Error("Seat does not belong to this branch.");

            if (newMultiShiftId) {
                const multiShift = await tx.multiShift.findUnique({
                    where: { id: newMultiShiftId },
                    select: { branchId: true },
                });
                if (!multiShift) throw new Error("Multi-shift not found.");
                if (multiShift.branchId !== branchId)
                    throw new Error("Multi-shift does not belong to this branch.");
            }

            // Validate new shifts
            const shifts = await tx.shift.findMany({
                where: { id: { in: newShiftIds } },
            });
            if (shifts.length !== newShiftIds.length)
                throw new Error("One or more new shifts were not found.");
            for (const s of shifts) {
                if (s.status !== "ACTIVE") throw new Error(`Shift "${s.name}" is not active.`);
                if (s.branchId !== branchId) throw new Error(`Shift "${s.name}" does not belong to this branch.`);
            }

            // ⚡ Bolt: Optimizing bulk allocation creation
            // Impact: Replaced N queries (Promise.all + create) with a single createManyAndReturn bulk operation
            // This reduces DB roundtrips while preserving the returned records.
            const payload = newShiftIds.map((shiftId) => ({
                seatId: newSeatId,
                studentId,
                shiftId,
                ...(newMultiShiftId ? { multiShiftId: newMultiShiftId } : {}),
            }));

            const created = await tx.seatAllocation.createManyAndReturn({
                data: payload,
            });

            await tx.branch.update({
                where: { id: branchId },
                data: { lastDataChange: new Date() },
            });

            return created;
        });
    }

    /**
     * List allocations for a branch with optional filters.
     */
    static async listAllocations(
        userId: string,
        branchId: string,
        filters: SeatAllocationFilters = {},
        options: SeatAllocationListOptions = {}
    ) {
        await StaffService.authorize(userId, branchId, "seat_allocation");

        if (filters.shiftId && filters.multiShiftId) {
            throw new Error("shiftId and multiShiftId cannot be combined");
        }
        if (filters.multiShiftId) {
            const multiShift = await prisma.multiShift.findUnique({
                where: { id: filters.multiShiftId },
                select: { branchId: true },
            });
            if (!multiShift || multiShift.branchId !== branchId) {
                throw new Error("Multi-shift not found");
            }
        }

        const limit = options.limit ?? DEFAULT_PAGE_SIZE;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
            throw new PaginationInputError(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
        }

        const endDate = filters.status === "ACTIVE" || filters.activeOnly
            ? null
            : filters.status === "ENDED"
                ? { not: null }
                : undefined;
        const baseWhere: Prisma.SeatAllocationWhereInput = {
            seat: { branchId },
            studentId: filters.studentId,
            shiftId: filters.shiftId,
            multiShiftId: filters.multiShiftId,
            endDate,
        };
        const pageWhere: Prisma.SeatAllocationWhereInput = options.cursor
            ? {
                ...baseWhere,
                OR: [
                    { startDate: { lt: options.cursor.sort } },
                    {
                        startDate: options.cursor.sort,
                        id: { lt: options.cursor.id },
                    },
                ],
            }
            : baseWhere;

        const query = {
            where: options.all ? baseWhere : pageWhere,
            include: {
                seat: true,
                student: true,
                shift: true,
                multiShift: { select: { id: true, name: true } },
            },
            orderBy: [
                { startDate: "desc" as const },
                { id: "desc" as const },
            ],
            ...(options.all ? {} : { take: limit + 1 }),
        } satisfies Prisma.SeatAllocationFindManyArgs;

        const [allocations, total] = await Promise.all([
            prisma.seatAllocation.findMany(query),
            prisma.seatAllocation.count({ where: baseWhere }),
        ]);

        if (options.all) {
            return { items: allocations, nextCursor: null, total };
        }

        return pageFromRows(allocations, limit, total, allocation => ({
            sort: allocation.startDate,
            id: allocation.id,
        }));
    }
}
