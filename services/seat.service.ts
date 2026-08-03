import { prisma } from "@/lib/prisma";
import { StaffService } from "@/services/staff.service";
import type { StaffAction } from "@/types";
import { parseNullableTime, timesOverlap } from "@/utils/shiftTime";
import { validateSeatLabel } from "@/lib/formValidation";
import { generateSeatLabels, sortSeatsByLabel, validateSeatNumberingConfig } from "@/lib/seatNumbering";
import { endOfDay } from "date-fns";
import { EntitlementService } from "@/services/entitlement.service";

function isUniqueConstraintError(error: unknown) {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "P2002";
}

export type SeatOccupancySnapshot = {
    branchId: string
    seatCount: number
    shiftCount: number
    totalShiftCapacity: number
    totalUsedSlots: number
    totalOccupancyPercent: number
    shifts: {
        shiftId: string
        shiftName: string
        used: number
        capacity: number
        occupancyPercent: number
    }[]
    generatedAt: Date
}

export class SeatService {
    /**
     * Helper to verify that the user can perform an action in the branch.
     */
    private static async assertBranchAccess(userId: string, branchId: string, action: StaffAction) {
        await StaffService.authorize(userId, branchId, action);

        const branch = await prisma.branch.findUnique({ where: { id: branchId } });

        if (!branch) {
            throw new Error("Branch not found");
        }

        return branch;
    }

    static async createSeat(userId: string, branchId: string, label: string) {
        await this.assertBranchAccess(userId, branchId, "manage_branch");
        await EntitlementService.assertBranchWritable(branchId);
        const labelResult = validateSeatLabel(label);
        if (!labelResult.ok) throw new Error(labelResult.error);

        // Check if seat label already exists for this branch to avoid unique constraint error
        const existingSeat = await prisma.seat.findUnique({
            where: {
                branchId_label: {
                    branchId,
                    label: labelResult.value,
                },
            },
        });

        if (existingSeat) {
            throw new Error(`Seat with label "${labelResult.value}" already exists in this branch.`);
        }

        return prisma.seat.create({
            data: {
                branchId,
                label: labelResult.value,
            },
        });
    }

    static async generateSeats(userId: string, branchId: string, seatNumbering: unknown) {
        await this.assertBranchAccess(userId, branchId, "manage_branch");
        await EntitlementService.assertBranchWritable(branchId);

        const numberingResult = validateSeatNumberingConfig(seatNumbering);
        if (!numberingResult.ok) throw new Error(numberingResult.error);

        const labelsResult = generateSeatLabels(numberingResult.value);
        if (!labelsResult.ok) throw new Error(labelsResult.error);
        const labels = labelsResult.value;
        if (labels.length === 0) throw new Error("Seat numbering must create at least one seat.");

        try {
            return await prisma.$transaction(async (tx) => {
                const existingSeats = await tx.seat.findMany({
                    where: { branchId },
                    select: { label: true },
                });
                const existingByKey = new Map(existingSeats.map(seat => [seat.label.toLowerCase(), seat.label]));
                const duplicateLabel = labels.find(label => existingByKey.has(label.toLowerCase()));

                if (duplicateLabel) {
                    const existing = existingByKey.get(duplicateLabel.toLowerCase()) ?? duplicateLabel;
                    throw new Error(`Seat with label "${existing}" already exists in this branch.`);
                }

                await tx.seat.createMany({
                    data: labels.map(label => ({ branchId, label })),
                });

                const createdSeats = await tx.seat.findMany({
                    where: {
                        branchId,
                        label: { in: labels },
                    },
                });

                return sortSeatsByLabel(createdSeats);
            });
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                throw new Error("One or more generated seat labels already exists in this branch.");
            }
            throw error;
        }
    }

    static async listSeats(userId: string, branchId: string, shiftId?: string) {
        await this.assertBranchAccess(userId, branchId, "seat_allocation");

        const seats = await prisma.seat.findMany({
            where: {
                branchId,
            },
            include: {
                seatAllocations: {
                    where: {
                        endDate: null, // Only active allocations
                        ...(shiftId ? { shiftId } : {}),
                    },
                    include: {
                        student: {
                            select: {
                                id: true,
                                name: true,
                                phone: true,
                                status: true,
                                monthlyFee: true,
                            },
                        },
                        shift: {
                            select: {
                                id: true,
                                name: true,
                                startTime: true,
                                endTime: true,
                                isReserved: true,
                            },
                        },
                        multiShift: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                label: "asc",
            },
        });

        return sortSeatsByLabel(seats);
    }

    static async generateOccupancySnapshot(branchId: string, asOf?: Date): Promise<SeatOccupancySnapshot> {
        const date = asOf ?? new Date()
        const allocationStartCutoff = endOfDay(date)

        // ⚡ Bolt: Fetch branch info and active allocations concurrently to prevent waterfall delay
        const [branchInfo, activeAllocations] = await Promise.all([
            prisma.branch.findUnique({
                where: { id: branchId },
                select: {
                    _count: { select: { seats: true } },
                    shifts: { where: { status: "ACTIVE" }, select: { id: true, name: true } }
                }
            }),
            prisma.seatAllocation.findMany({
                where: {
                    seat: { branchId },
                    startDate: { lte: allocationStartCutoff },
                    OR: [
                        { endDate: null },
                        { endDate: { gt: date } },
                    ],
                },
                select: { shiftId: true }
            })
        ]);

        if (!branchInfo) {
            throw new Error(`Branch ${branchId} not found`)
        }

        const seatCount = branchInfo._count.seats
        const shiftCount = branchInfo.shifts.length
        const totalShiftCapacity = seatCount * shiftCount

        const shiftBuckets: Record<string, { shiftName: string; used: number; capacity: number }> = {}
        for (const shift of branchInfo.shifts) {
            shiftBuckets[shift.id] = {
                shiftName: shift.name,
                used: 0,
                capacity: seatCount,
            }
        }

        for (const alloc of activeAllocations) {
            if (shiftBuckets[alloc.shiftId]) {
                shiftBuckets[alloc.shiftId].used += 1
            }
        }

        let totalUsedSlots = 0
        const shiftsResult = []

        for (const shiftId in shiftBuckets) {
            const bucket = shiftBuckets[shiftId]

            // Invariant: Per-shift used must never exceed seatCount
            if (bucket.used > bucket.capacity) {
                console.warn(`[SeatOccupancySnapshot] Shift ${shiftId} used (${bucket.used}) exceeds capacity (${bucket.capacity}). Capping to capacity.`)
                bucket.used = bucket.capacity
            }

            totalUsedSlots += bucket.used

            const occupancyPercent = bucket.capacity === 0 ? 0 : (bucket.used / bucket.capacity) * 100

            shiftsResult.push({
                shiftId,
                shiftName: bucket.shiftName,
                used: bucket.used,
                capacity: bucket.capacity,
                occupancyPercent
            })
        }

        // Invariant: totalUsedSlots must never exceed totalShiftCapacity
        if (totalUsedSlots > totalShiftCapacity) {
            console.warn(`[SeatOccupancySnapshot] totalUsedSlots (${totalUsedSlots}) exceeds totalShiftCapacity (${totalShiftCapacity}). Capping to capacity.`)
            totalUsedSlots = totalShiftCapacity
        }

        const totalOccupancyPercent = totalShiftCapacity === 0 ? 0 : (totalUsedSlots / totalShiftCapacity) * 100

        return {
            branchId,
            seatCount,
            shiftCount,
            totalShiftCapacity,
            totalUsedSlots,
            totalOccupancyPercent,
            shifts: shiftsResult,
            generatedAt: date
        }
    }

    /**
     * Returns a visual seat map for a specific shift or multi-shift.
     *
     * PRIMARY shift mode (multiShiftId is absent):
     *   A seat is occupied if it has an active allocation in the requested shift
     *   OR in any shift whose time window overlaps with it (properly handling full-day/null times).
     *
     * MULTI-SHIFT mode (multiShiftId is provided):
     *   A seat is occupied if it has an active allocation in ANY of the
     *   multi-shift's component (primary) shifts, OR overlaps with ANY of them.
     */
    static async getSeatMap(
        userId: string,
        branchId: string,
        shiftId: string,
        multiShiftId?: string,
        excludeAllocationIds?: string[]
    ) {
        await this.assertBranchAccess(userId, branchId, "seat_allocation");

        // ── MULTI-SHIFT PATH ──────────────────────────────────────────────────
        if (multiShiftId) {
            const ms = await prisma.multiShift.findUnique({
                where: { id: multiShiftId },
                include: {
                    components: { select: { shiftId: true } },
                },
            });
            if (!ms || ms.branchId !== branchId) throw new Error("Multi-shift not found");
            if (ms.components.length === 0) throw new Error("Multi-shift has no component shifts");

            // Set of exact component shift IDs for fast membership check
            const componentShiftIds = new Set(ms.components.map(c => c.shiftId));

            const allShifts = await prisma.shift.findMany({
                where: { branchId, status: "ACTIVE" },
                select: { id: true, startTime: true, endTime: true },
            });
            const shiftTimeMap = new Map(allShifts.map(s => [s.id, s]));

            const seats = sortSeatsByLabel(await prisma.seat.findMany({
                where: { branchId },
                include: {
                    seatAllocations: {
                        where: {
                            endDate: null,
                            ...(excludeAllocationIds?.length
                                ? { id: { notIn: excludeAllocationIds } }
                                : {}),
                        },
                        include: { student: { select: { name: true } } },
                    },
                },
                orderBy: { label: "asc" },
            }));

            for (const componentId of componentShiftIds) {
                const s = shiftTimeMap.get(componentId);
                parseNullableTime(s?.startTime);
                parseNullableTime(s?.endTime);
            }

            const totalSeats = seats.length;
            let occupiedCount = 0;

            const mappedSeats = seats.map(s => {
                const alloc = s.seatAllocations.find(a => componentShiftIds.has(a.shiftId));
                const occupiedBy = alloc ? alloc.student.name : null;

                if (occupiedBy) occupiedCount++;

                return {
                    seatId: s.id,
                    label: s.label,
                    occupied: occupiedBy !== null,
                    occupiedBy,
                };
            });

            return {
                shiftId: multiShiftId,
                shiftName: ms.name,
                isReserved: false,
                totalSeats,
                occupiedCount,
                availableCount: totalSeats - occupiedCount,
                seats: mappedSeats,
            };
        }

        // ── PRIMARY SHIFT PATH ────────────────────────────────────────────────
        // ⚡ Fetch requested shift, all active shifts, and seats concurrently
        const [shift, allShifts, seats] = await Promise.all([
            prisma.shift.findUnique({ where: { id: shiftId } }),
            prisma.shift.findMany({
                where: { branchId, status: "ACTIVE" },
                select: { id: true, startTime: true, endTime: true },
            }),
            prisma.seat.findMany({
                where: { branchId },
                include: {
                    seatAllocations: {
                        where: {
                            endDate: null,
                            ...(excludeAllocationIds?.length
                                ? { id: { notIn: excludeAllocationIds } }
                                : {}),
                        },
                        include: { student: { select: { name: true } }, shift: { select: { startTime: true, endTime: true } } },
                    },
                },
                orderBy: { label: "asc" },
            })
        ]);

        if (!shift || shift.branchId !== branchId) throw new Error("Shift not found");

        // Determine the time window of the requested shift utilizing robust logic that respects full-day mappings
        const requestedStart = parseNullableTime(shift.startTime);
        const requestedEnd = parseNullableTime(shift.endTime);

        const shiftTimeMap = new Map(allShifts.map(s => [s.id, s]));

        const sortedSeats = sortSeatsByLabel(seats);
        const totalSeats = sortedSeats.length;
        let occupiedCount = 0;

        const mappedSeats = sortedSeats.map(s => {
            // Find any active allocation that conflicts with the requested shift's time window
            let occupiedBy: string | null = null;

            for (const alloc of s.seatAllocations) {
                // Exact shift match — always occupied
                if (alloc.shiftId === shiftId) {
                    occupiedBy = alloc.student.name;
                    break;
                }

                // Time-overlap match combining robust parseNullableTime and timesOverlap
                const existingShift = shiftTimeMap.get(alloc.shiftId);
                if (existingShift) {
                    const es = parseNullableTime(existingShift.startTime);
                    const ee = parseNullableTime(existingShift.endTime);
                    if (timesOverlap(requestedStart, requestedEnd, es, ee)) {
                        occupiedBy = alloc.student.name;
                        break;
                    }
                }
            }

            if (occupiedBy) occupiedCount++;

            return {
                seatId: s.id,
                label: s.label,
                occupied: occupiedBy !== null,
                occupiedBy,
            };
        });

        return {
            shiftId: shift.id,
            shiftName: shift.name,
            isReserved: shift.isReserved,
            totalSeats,
            occupiedCount,
            availableCount: totalSeats - occupiedCount,
            seats: mappedSeats,
        };
    }

    /**
     * Returns all active primary shifts with current capacity counts.
     * If studentId is provided, marks a shift as studentAlreadyAllocated when
     * the student has any active allocation that time-overlaps with that shift.
     */
    static async getShiftsCapacity(userId: string, branchId: string, studentId?: string, excludeAllocationIds?: string[]) {
        await this.assertBranchAccess(userId, branchId, "seat_allocation");

        // ⚡ Bolt: Fetch total seats, active shifts, and optionally student's allocations concurrently
        const [totalSeats, shifts, rawAllocations] = await Promise.all([
            prisma.seat.count({ where: { branchId } }),
            prisma.shift.findMany({
                where: { branchId, status: "ACTIVE" },
                include: {
                    _count: { select: { seatAllocations: { where: { endDate: null } } } },
                },
                orderBy: { name: "asc" },
            }),
            studentId ? prisma.seatAllocation.findMany({
                where: {
                    studentId,
                    endDate: null,
                    ...(excludeAllocationIds?.length
                        ? { id: { notIn: excludeAllocationIds } }
                        : {}),
                },
                include: { shift: { select: { id: true, startTime: true, endTime: true } } },
            }) : Promise.resolve([])
        ]);

        // Load student's current allocations with their shift times
        type AllocWithTime = { shiftId: string; startTime: string | null; endTime: string | null };
        const studentAllocations: AllocWithTime[] = [];
        if (studentId && rawAllocations.length > 0) {
            for (const a of rawAllocations) {
                studentAllocations.push({
                    shiftId: a.shiftId,
                    startTime: a.shift.startTime,
                    endTime: a.shift.endTime,
                });
            }
        }

        return shifts.map(shift => {
            const used = shift._count.seatAllocations;
            const available = Math.max(0, totalSeats - used);
            const occupancyPercent = totalSeats === 0 ? 0 : (used / totalSeats) * 100;

            // Check if student is already allocated in this shift or any overlapping shift
            let studentAlreadyAllocated = false;
            if (studentId && studentAllocations.length > 0) {
                const shiftStart = parseNullableTime(shift.startTime);
                const shiftEnd = parseNullableTime(shift.endTime);

                for (const alloc of studentAllocations) {
                    if (alloc.shiftId === shift.id) {
                        studentAlreadyAllocated = true;
                        break;
                    }
                    if (timesOverlap(shiftStart, shiftEnd, parseNullableTime(alloc.startTime), parseNullableTime(alloc.endTime))) {
                        studentAlreadyAllocated = true;
                        break;
                    }
                }
            }

            return {
                type: "PRIMARY" as const,
                shiftId: shift.id,
                multiShiftId: undefined as string | undefined,
                name: shift.name,
                startTime: shift.startTime,
                endTime: shift.endTime,
                price: shift.price,
                isReserved: shift.isReserved,
                totalSeats,
                used,
                available,
                occupancyPercent,
                isFull: available === 0,
                studentAlreadyAllocated,
                componentShiftIds: undefined as string[] | undefined,
                componentShiftNames: undefined as string[] | undefined,
            };
        });
    }

    /**
     * Returns primary shifts + multi-shifts combined for the shift picker.
     * Multi-shift entries aggregate capacity from their component primary shifts.
     */
    static async getShiftsCapacityWithMulti(userId: string, branchId: string, studentId?: string, excludeAllocationIds?: string[]) {
        const primaryItems = await this.getShiftsCapacity(userId, branchId, studentId, excludeAllocationIds);
        const primaryMap = new Map(primaryItems.map(p => [p.shiftId, p]));

        const multiShifts = await prisma.multiShift.findMany({
            where: { branchId },
            include: {
                components: {
                    include: { shift: { select: { id: true, name: true, startTime: true, endTime: true } } },
                    orderBy: { order: "asc" },
                },
            },
            orderBy: { name: "asc" },
        });

        const multiItems = multiShifts.map(ms => {
            const componentShiftIds = ms.components.map(c => c.shiftId);
            const componentShiftNames = ms.components.map(c => c.shift.name);
            const validComponents = componentShiftIds.map(id => primaryMap.get(id)).filter(Boolean) as typeof primaryItems[number][];

            const available = validComponents.length > 0 ? Math.min(...validComponents.map(c => c.available)) : 0;
            const used = validComponents.length > 0 ? Math.max(...validComponents.map(c => c.used)) : 0;
            const totalSeats = validComponents[0]?.totalSeats ?? 0;
            const occupancyPercent = totalSeats === 0 ? 0 : (used / totalSeats) * 100;
            const isFull = available === 0;
            const studentAlreadyAllocated = validComponents.some(c => c.studentAlreadyAllocated);

            return {
                type: "MULTISHIFT" as const,
                shiftId: ms.id,
                multiShiftId: ms.id,
                name: ms.name,
                startTime: ms.components[0]?.shift.startTime ?? null,
                endTime: ms.components[ms.components.length - 1]?.shift.endTime ?? null,
                price: ms.price,
                isReserved: false,
                totalSeats,
                used,
                available,
                occupancyPercent,
                isFull,
                studentAlreadyAllocated,
                componentShiftIds,
                componentShiftNames,
            };
        });

        return [...primaryItems, ...multiItems];
    }
}
