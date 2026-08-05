
import { prisma } from "@/lib/prisma";
import { StaffService } from "@/services/staff.service";
import { CreateShiftDto } from "@/types";
import type { StaffAction } from "@/types";
import type { Prisma } from "@/app/generated/prisma/client";
import { parseNullableTime, timesOverlap } from "@/utils/shiftTime";
import { sortSeatsByLabel } from "@/lib/seatNumbering";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalTime,
    validateRequiredText,
} from "@/lib/formValidation";
import { DEFAULT_PRIMARY_SHIFTS, ensureDefaultShiftsAndFullTime } from "@/services/defaultShifts";
import { EntitlementService } from "@/services/entitlement.service";

export const DEFAULT_SHIFTS = DEFAULT_PRIMARY_SHIFTS;

// ─── Resolution Plan Types ─────────────────────────────────────────────────────

export type ResolutionPlan =
    | { type: "END_ALL" }
    | { type: "REALLOCATE_BULK"; targetShiftId: string }
    | { type: "REALLOCATE_MANUAL"; assignments: { allocationId: string; targetShiftId: string }[] };

export interface ShiftImpactAnalysis {
    studentsInShift: number;
    allocations: { allocationId: string; studentId: string; studentName: string; seatLabel: string }[];
    otherShifts: { shiftId: string; name: string; totalSeats: number; activeAllocations: number; emptySeats: number }[];
    totalEmptyElsewhere: number;
    shiftsWithEnoughCapacity: string[];
    willOverflowBy: number;
    isLastActiveShift: boolean;
}

export class ShiftService {
    private static async assertBranchAccess(userId: string, branchId: string, action: StaffAction) {
        await StaffService.authorize(userId, branchId, action);

        const branch = await prisma.branch.findUnique({ where: { id: branchId } });
        if (!branch) throw new Error("Branch not found");
        return branch;
    }

    /**
     * Validates that the given time window does not overlap with any existing
     * ACTIVE shift in the branch. Throws a descriptive error if a conflict is found.
     * @param excludeShiftId - skip this shift ID when checking (used for updates)
     */
    private static async checkTimeOverlap(
        branchId: string,
        startTime: string | null,
        endTime: string | null,
        excludeShiftId?: string
    ) {
        const newStart = parseNullableTime(startTime);
        const newEnd = parseNullableTime(endTime);

        const activeShifts = await prisma.shift.findMany({
            where: {
                branchId,
                status: "ACTIVE",
                ...(excludeShiftId ? { id: { not: excludeShiftId } } : {}),
            },
            select: { id: true, name: true, startTime: true, endTime: true },
        });

        for (const shift of activeShifts) {
            const existStart = parseNullableTime(shift.startTime);
            const existEnd = parseNullableTime(shift.endTime);
            if (timesOverlap(newStart, newEnd, existStart, existEnd)) {
                throw new Error(
                    `Shift time overlaps with an existing active shift ("${shift.name}": ${shift.startTime ?? "?"} – ${shift.endTime ?? "?"})`
                );
            }
        }
    }

    static async createShift(userId: string, branchId: string, data: CreateShiftDto) {
        await this.assertBranchAccess(userId, branchId, "manage_branch");
        await EntitlementService.assertBranchWritable(branchId);
        const nameResult = validateRequiredText(data.name, "Shift name", 50);
        if (!nameResult.ok) throw new Error(nameResult.error);
        const startResult = validateOptionalTime(data.startTime, "Start time");
        if (!startResult.ok) throw new Error(startResult.error);
        const endResult = validateOptionalTime(data.endTime, "End time");
        if (!endResult.ok) throw new Error(endResult.error);
        if ((startResult.value && !endResult.value) || (!startResult.value && endResult.value)) {
            throw new Error("Shift must have both start and end time, or neither.");
        }
        const priceResult = parseIntegerField(data.price, "Monthly price", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!priceResult.ok) throw new Error(priceResult.error);

        const existingShift = await prisma.shift.findFirst({
            where: { branchId, name: nameResult.value, status: "ACTIVE" },
        });
        if (existingShift) throw new Error(`Shift with name "${nameResult.value}" already exists in this branch.`);

        // Always check overlap, even for null times (null = full day, overlaps everything)
        await this.checkTimeOverlap(branchId, startResult.value, endResult.value);

        return prisma.shift.create({
            data: {
                branchId,
                name: nameResult.value,
                startTime: startResult.value,
                endTime: endResult.value,
                price: priceResult.value ?? 0,
                isReserved: data.isReserved ?? false,
            },
        });
    }

    static async updateShift(
        userId: string,
        shiftId: string,
        data: Partial<{ name: string; startTime: string | null; endTime: string | null; price: number; isReserved: boolean }>
    ) {
        const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
        if (!shift) throw new Error("Shift not found");
        await this.assertBranchAccess(userId, shift.branchId, "manage_branch");
        await EntitlementService.assertBranchWritable(shift.branchId);

        const nameResult = data.name !== undefined ? validateRequiredText(data.name, "Shift name", 50) : null;
        if (nameResult && !nameResult.ok) throw new Error(nameResult.error);
        const startResult = data.startTime !== undefined ? validateOptionalTime(data.startTime, "Start time") : null;
        if (startResult && !startResult.ok) throw new Error(startResult.error);
        const endResult = data.endTime !== undefined ? validateOptionalTime(data.endTime, "End time") : null;
        if (endResult && !endResult.ok) throw new Error(endResult.error);
        const priceResult = data.price !== undefined
            ? parseIntegerField(data.price, "Monthly price", { min: 0, max: FORM_LIMITS.moneyMax })
            : null;
        if (priceResult && !priceResult.ok) throw new Error(priceResult.error);

        const normalizedName = nameResult?.ok ? nameResult.value : undefined;
        if (normalizedName && normalizedName !== shift.name) {
            const duplicate = await prisma.shift.findFirst({
                where: { branchId: shift.branchId, name: normalizedName, status: "ACTIVE", id: { not: shiftId } },
            });
            if (duplicate) throw new Error(`Shift with name "${normalizedName}" already exists in this branch.`);
        }

        const newStart = startResult?.ok ? startResult.value : shift.startTime;
        const newEnd = endResult?.ok ? endResult.value : shift.endTime;
        if ((newStart && !newEnd) || (!newStart && newEnd)) {
            throw new Error("Shift must have both start and end time, or neither.");
        }
        if (data.startTime !== undefined || data.endTime !== undefined) {
            await this.checkTimeOverlap(shift.branchId, newStart ?? null, newEnd ?? null, shiftId);
        }

        const normalizedPrice = priceResult?.ok ? priceResult.value : undefined;
        const priceChanged = normalizedPrice !== undefined && normalizedPrice !== shift.price;

        return prisma.$transaction(async (tx) => {
            const updated = await tx.shift.update({
                where: { id: shiftId },
                data: {
                    ...(normalizedName !== undefined ? { name: normalizedName } : {}),
                    ...(data.startTime !== undefined ? { startTime: newStart } : {}),
                    ...(data.endTime !== undefined ? { endTime: newEnd } : {}),
                    ...(normalizedPrice !== undefined ? { price: normalizedPrice } : {}),
                    ...(data.isReserved !== undefined ? { isReserved: data.isReserved } : {}),
                },
            });

            if (priceChanged) {
                await tx.student.updateMany({
                    where: {
                        branchId: shift.branchId,
                        feeLinkedShiftId: shiftId,
                    },
                    data: {
                        monthlyFee: normalizedPrice,
                    },
                });
            }

            await tx.branch.update({
                where: { id: shift.branchId },
                data: { lastDataChange: new Date() },
            });

            return updated;
        });
    }

    // ─── Analyze shift deletion impact (read-only) ────────────────────────────

    static async analyzeShiftDeletion(userId: string, shiftId: string): Promise<ShiftImpactAnalysis> {
        const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
        if (!shift) throw new Error("Shift not found");
        await this.assertBranchAccess(userId, shift.branchId, "manage_branch");
        await EntitlementService.assertBranchWritable(shift.branchId);

        const branchId = shift.branchId;

        const activeShiftCount = await prisma.shift.count({
            where: { branchId, status: "ACTIVE" },
        });
        const isLastActiveShift = activeShiftCount <= 1;

        const rawAllocations = await prisma.seatAllocation.findMany({
            where: { shiftId, endDate: null },
            include: {
                student: { select: { id: true, name: true } },
                seat: { select: { label: true } },
            },
        });

        const allocations = rawAllocations.map(a => ({
            allocationId: a.id,
            studentId: a.student.id,
            studentName: a.student.name,
            seatLabel: a.seat.label,
        }));

        const studentsInShift = allocations.length;

        const otherActiveShifts = await prisma.shift.findMany({
            where: { branchId, status: "ACTIVE", id: { not: shiftId } },
            include: {
                _count: { select: { seatAllocations: { where: { endDate: null } } } },
            },
        });

        const totalBranchSeats = await prisma.seat.count({ where: { branchId } });

        const otherShifts = otherActiveShifts.map(s => {
            const activeAllocations = s._count.seatAllocations;
            const emptySeats = Math.max(0, totalBranchSeats - activeAllocations);
            return {
                shiftId: s.id,
                name: s.name,
                totalSeats: totalBranchSeats,
                activeAllocations,
                emptySeats,
            };
        });

        const totalEmptyElsewhere = otherShifts.reduce((sum, s) => sum + s.emptySeats, 0);
        const willOverflowBy = Math.max(0, studentsInShift - totalEmptyElsewhere);
        const shiftsWithEnoughCapacity = otherShifts
            .filter(s => s.emptySeats >= studentsInShift)
            .map(s => s.shiftId);

        return {
            studentsInShift,
            allocations,
            otherShifts,
            totalEmptyElsewhere,
            shiftsWithEnoughCapacity,
            willOverflowBy,
            isLastActiveShift,
        };
    }

    // ─── Delete shift with resolution (transactional) ─────────────────────────

    static async deleteShift(userId: string, shiftId: string, resolution: ResolutionPlan) {
        const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
        if (!shift) throw new Error("Shift not found");
        await this.assertBranchAccess(userId, shift.branchId, "manage_branch");
        await EntitlementService.assertBranchWritable(shift.branchId);

        const branchId = shift.branchId;

        const activeShiftCount = await prisma.shift.count({
            where: { branchId, status: "ACTIVE" },
        });
        if (activeShiftCount <= 1) {
            throw new Error("Cannot delete the last active shift in this branch.");
        }

        const now = new Date();

        if (resolution.type === "END_ALL") {
            await prisma.$transaction(async (tx) => {
                await tx.seatAllocation.updateMany({
                    where: { shiftId, endDate: null },
                    data: { endDate: now },
                });
                await tx.student.updateMany({
                    where: { branchId, feeLinkedShiftId: shiftId },
                    data: { feeLinkedShiftId: null },
                });
                await tx.shift.update({
                    where: { id: shiftId },
                    data: { status: "INACTIVE", deletedAt: now },
                });
            });
            return { success: true };
        }

        if (resolution.type === "REALLOCATE_BULK") {
            const { targetShiftId } = resolution;

            await prisma.$transaction(async (tx) => {
                // Validate target shift
                const target = await tx.shift.findUnique({ where: { id: targetShiftId } });
                if (!target || target.status !== "ACTIVE") throw new Error("Target shift not found or inactive.");
                if (target.id === shiftId) throw new Error("Target shift cannot be the same shift.");

                // Validate capacity
                const totalSeats = await tx.seat.count({ where: { branchId } });
                const targetActive = await tx.seatAllocation.count({
                    where: { shiftId: targetShiftId, endDate: null },
                });
                const sourceAllocations = await tx.seatAllocation.findMany({
                    where: { shiftId, endDate: null },
                    include: { seat: true, student: true },
                });

                if (targetActive + sourceAllocations.length > totalSeats) {
                    throw new Error("Target shift does not have enough capacity for all students.");
                }

                // Load all branch shifts for overlap comparison
                const allShifts = await tx.shift.findMany({
                    where: { branchId, status: "ACTIVE" },
                    select: { id: true, startTime: true, endTime: true },
                });
                const shiftMap = new Map(allShifts.map(s => [s.id, s]));

                const targetShiftData = shiftMap.get(targetShiftId);
                const targetStart = parseNullableTime(targetShiftData?.startTime);
                const targetEnd = parseNullableTime(targetShiftData?.endTime);

                for (const oldAlloc of sourceAllocations) {
                    // Check: student not already in target or any time-overlapping shift
                    const studentActiveAllocs = await tx.seatAllocation.findMany({
                        where: { studentId: oldAlloc.studentId, endDate: null, shiftId: { not: shiftId } },
                    });
                    for (const sa of studentActiveAllocs) {
                        if (sa.shiftId === targetShiftId) {
                            throw new Error(
                                `Student "${oldAlloc.student.name}" is already allocated in the target shift.`
                            );
                        }
                        const existing = shiftMap.get(sa.shiftId);
                        if (timesOverlap(targetStart, targetEnd, parseNullableTime(existing?.startTime), parseNullableTime(existing?.endTime))) {
                            throw new Error(
                                `Student "${oldAlloc.student.name}" is already in an overlapping shift.`
                            );
                        }
                    }
                }

                // Find available seats in branchId not occupied in targetShift (or its time-overlapping shifts)
                const allTargetOverlapShiftIds = allShifts
                    .filter(s => s.id !== shiftId && timesOverlap(targetStart, targetEnd, parseNullableTime(s.startTime), parseNullableTime(s.endTime)))
                    .map(s => s.id);

                const occupiedSeatIds = (await tx.seatAllocation.findMany({
                    where: { shiftId: { in: allTargetOverlapShiftIds }, endDate: null },
                    select: { seatId: true },
                })).map(a => a.seatId);

                const availableSeats = sortSeatsByLabel(await tx.seat.findMany({
                    where: { branchId, id: { notIn: occupiedSeatIds } },
                    orderBy: { label: "asc" },
                })).slice(0, sourceAllocations.length);

                if (availableSeats.length < sourceAllocations.length) {
                    throw new Error("Not enough unoccupied seats available in target shift.");
                }

                // ⚡ Bolt: Optimizing bulk shift reassignment.
                // Impact: Changed O(n) individual updates/creates to two batch operations (updateMany and createMany).
                // Significantly reduces DB overhead and locks during reallocations.
                const oldAllocIds = sourceAllocations.map(a => a.id);
                await tx.seatAllocation.updateMany({
                    where: { id: { in: oldAllocIds } },
                    data: { endDate: now },
                });

                const newAllocations = sourceAllocations.map((oldAlloc, i) => ({
                    studentId: oldAlloc.studentId,
                    shiftId: targetShiftId,
                    seatId: availableSeats[i].id,
                    startDate: now,
                }));

                if (newAllocations.length > 0) {
                    await tx.seatAllocation.createMany({
                        data: newAllocations,
                    });
                }

                await tx.student.updateMany({
                    where: { branchId, feeLinkedShiftId: shiftId },
                    data: { feeLinkedShiftId: null },
                });

                await tx.shift.update({
                    where: { id: shiftId },
                    data: { status: "INACTIVE", deletedAt: now },
                });
            });
            return { success: true };
        }

        if (resolution.type === "REALLOCATE_MANUAL") {
            const { assignments } = resolution;

            await prisma.$transaction(async (tx) => {
                const totalSeats = await tx.seat.count({ where: { branchId } });
                const allShifts = await tx.shift.findMany({
                    where: { branchId, status: "ACTIVE" },
                    select: { id: true, name: true, startTime: true, endTime: true },
                });
                const shiftMap = new Map(allShifts.map(s => [s.id, s]));

                // Group assignments by targetShiftId to validate capacity in bulk
                const targetShiftCounts = new Map<string, number>();
                for (const a of assignments) {
                    targetShiftCounts.set(a.targetShiftId, (targetShiftCounts.get(a.targetShiftId) ?? 0) + 1);
                }

                for (const [targetShiftId, incoming] of targetShiftCounts.entries()) {
                    const target = shiftMap.get(targetShiftId);
                    if (!target) throw new Error(`Target shift not found.`);
                    if (target.id === shiftId) throw new Error(`Target shift cannot be the same shift being deleted.`);

                    const currentActive = await tx.seatAllocation.count({
                        where: { shiftId: targetShiftId, endDate: null },
                    });
                    if (currentActive + incoming > totalSeats) {
                        throw new Error(`Shift "${target.name}" does not have enough capacity.`);
                    }
                }

                // ⚡ Bolt: Optimizing bulk shift manual reassignment.
                // Impact: Changed O(n) individual DB operations to batch operations (findMany, createMany, updateMany).

                // Fetch all source allocations at once
                const oldAllocIds = assignments.map(a => a.allocationId);
                const oldAllocs = await tx.seatAllocation.findMany({
                    where: { id: { in: oldAllocIds } },
                    include: { student: true },
                });
                const oldAllocMap = new Map(oldAllocs.map(a => [a.id, a]));

                // Fetch all active student allocations at once
                const studentIds = [...new Set(oldAllocs.map(a => a.studentId))];
                const activeStudentAllocs = await tx.seatAllocation.findMany({
                    where: { studentId: { in: studentIds }, endDate: null, shiftId: { not: shiftId } },
                });

                // Fetch all seats and all active allocations for the branch to manage seat capacity locally
                const allSeats = sortSeatsByLabel(await tx.seat.findMany({
                    where: { branchId },
                    orderBy: { label: "asc" },
                }));

                // We'll track seat allocations locally to account for newly assigned seats within the loop
                const branchActiveAllocs = await tx.seatAllocation.findMany({
                    where: { seat: { branchId }, endDate: null, shiftId: { not: shiftId } },
                });

                const newAllocationsToCreate: Prisma.SeatAllocationCreateManyInput[] = [];

                for (const assignment of assignments) {
                    const oldAlloc = oldAllocMap.get(assignment.allocationId);
                    if (!oldAlloc) throw new Error(`Allocation ${assignment.allocationId} not found.`);

                    const targetShiftData = shiftMap.get(assignment.targetShiftId);
                    const targetStart = parseNullableTime(targetShiftData?.startTime);
                    const targetEnd = parseNullableTime(targetShiftData?.endTime);

                    // Check student isn't already in target or overlapping shift
                    const studentAllocs = activeStudentAllocs.filter(a => a.studentId === oldAlloc.studentId);
                    for (const sa of studentAllocs) {
                        if (sa.shiftId === assignment.targetShiftId) {
                            throw new Error(
                                `Student "${oldAlloc.student.name}" is already in the target shift.`
                            );
                        }
                        const existing = shiftMap.get(sa.shiftId);
                        if (timesOverlap(targetStart, targetEnd, parseNullableTime(existing?.startTime), parseNullableTime(existing?.endTime))) {
                            throw new Error(
                                `Student "${oldAlloc.student.name}" is already in an overlapping shift.`
                            );
                        }
                    }

                    // Find an available seat for this specific target shift (overlap-aware)
                    const overlapShiftIds = allShifts
                        .filter(s => s.id !== shiftId && timesOverlap(targetStart, targetEnd, parseNullableTime(s.startTime), parseNullableTime(s.endTime)))
                        .map(s => s.id);

                    const occupiedSeatIds = new Set(
                        branchActiveAllocs
                            .filter(a => overlapShiftIds.includes(a.shiftId))
                            .map(a => a.seatId)
                    );

                    const availableSeat = allSeats.find(seat => !occupiedSeatIds.has(seat.id));

                    if (!availableSeat) throw new Error("No available seat found in target shift.");

                    newAllocationsToCreate.push({
                        studentId: oldAlloc.studentId,
                        shiftId: assignment.targetShiftId,
                        seatId: availableSeat.id,
                        startDate: now,
                    });

                    // Add to branchActiveAllocs so subsequent iterations see this seat as occupied
                    branchActiveAllocs.push({
                        id: crypto.randomUUID(),
                        seatId: availableSeat.id,
                        studentId: oldAlloc.studentId,
                        shiftId: assignment.targetShiftId,
                        multiShiftId: null,
                        startDate: now,
                        endDate: null
                    });

                    // Add to activeStudentAllocs so subsequent iterations see the student as allocated
                    activeStudentAllocs.push({
                        id: crypto.randomUUID(),
                        seatId: availableSeat.id,
                        studentId: oldAlloc.studentId,
                        shiftId: assignment.targetShiftId,
                        multiShiftId: null,
                        startDate: now,
                        endDate: null
                    });
                }

                if (oldAllocIds.length > 0) {
                    await tx.seatAllocation.updateMany({
                        where: { id: { in: oldAllocIds } },
                        data: { endDate: now },
                    });
                }

                if (newAllocationsToCreate.length > 0) {
                    await tx.seatAllocation.createMany({
                        data: newAllocationsToCreate,
                    });
                }

                await tx.student.updateMany({
                    where: { branchId, feeLinkedShiftId: shiftId },
                    data: { feeLinkedShiftId: null },
                });

                await tx.shift.update({
                    where: { id: shiftId },
                    data: { status: "INACTIVE", deletedAt: now },
                });
            });
            return { success: true };
        }

        throw new Error("Invalid resolution type.");
    }

    static async ensureDefaultShifts(branchId: string) {
        // ⚡ Bolt: Batch database queries to prevent N+1 bottleneck.
        // Replaced loop-based findFirst + create with a single findMany and createMany.
        await ensureDefaultShiftsAndFullTime(branchId);
    }

    static async listShifts(userId: string, branchId: string) {
        await this.assertBranchAccess(userId, branchId, "seat_allocation");
        await this.ensureDefaultShifts(branchId);
        return prisma.shift.findMany({
            where: { branchId, status: "ACTIVE" },
            orderBy: { name: "asc" },
        });
    }
}
