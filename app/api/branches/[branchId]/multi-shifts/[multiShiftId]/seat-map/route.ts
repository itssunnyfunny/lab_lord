import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { StaffService } from "@/services/staff.service";
import { sortSeatsByLabel } from "@/lib/seatNumbering";
import { parseNullableTime, timesOverlap } from "@/utils/shiftTime";

interface Params {
    params: Promise<{ branchId: string; multiShiftId: string }>;
}

/**
 * GET /api/branches/[branchId]/multi-shifts/[multiShiftId]/seat-map
 *
 * Returns the seat availability grid for a multi-shift.
 * A seat is ASSIGNED when it has an active allocation for this exact bundle.
 * Otherwise it is BLOCKED if it has any active allocation (endDate = null) in a shift
 * that is either:
 *   (a) one of the multi-shift's component shifts (exact match), OR
 *   (b) any other shift whose time window overlaps with any component shift.
 *
 * This mirrors exactly the conflict logic in assignSeatToShifts (step 7a).
 */
export async function GET(_req: Request, { params }: Params) {
    try {
        const { branchId, multiShiftId } = await params;
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        await StaffService.authorize(user.id, branchId, "seat_allocation");

        // Load multi-shift with component shift times
        const ms = await prisma.multiShift.findUnique({
            where: { id: multiShiftId },
            include: {
                components: {
                    include: { shift: { select: { id: true, startTime: true, endTime: true } } },
                },
            },
        });
        if (!ms || ms.branchId !== branchId) {
            return NextResponse.json({ error: "Multi-shift not found" }, { status: 404 });
        }

        const componentShiftIds = new Set(ms.components.map(c => c.shiftId));

        // All active shifts in branch — needed to resolve time windows of existing allocations
        const allShifts = await prisma.shift.findMany({
            where: { branchId, status: "ACTIVE" },
            select: { id: true, startTime: true, endTime: true },
        });
        const shiftTimeMap = new Map(allShifts.map(s => [s.id, s]));

        // All seats with their active allocations
        const seats = sortSeatsByLabel(await prisma.seat.findMany({
            where: { branchId },
            include: {
                seatAllocations: {
                    where: { endDate: null },
                    include: { student: { select: { name: true } } },
                },
            },
            orderBy: { label: "asc" },
        }));

        let assignedCount = 0;
        let blockedCount = 0;

        const seatList = seats.map(seat => {
            const exactAllocation = seat.seatAllocations.find(
                allocation => allocation.multiShiftId === multiShiftId
            );
            if (exactAllocation) {
                assignedCount++;
                return {
                    seatId: seat.id,
                    label: seat.label,
                    status: "ASSIGNED" as const,
                    occupied: true,
                    occupiedBy: exactAllocation.student.name,
                };
            }

            let blockedBy: string | null = null;

            for (const alloc of seat.seatAllocations) {
                // (a) exact component shift match
                if (componentShiftIds.has(alloc.shiftId)) {
                    blockedBy = alloc.student.name;
                    break;
                }

                // (b) time-overlap with any component shift
                const allocShift = shiftTimeMap.get(alloc.shiftId);
                if (allocShift) {
                    const as = parseNullableTime(allocShift.startTime);
                    const ae = parseNullableTime(allocShift.endTime);
                    for (const comp of ms.components) {
                        const cs = parseNullableTime(comp.shift.startTime);
                        const ce = parseNullableTime(comp.shift.endTime);
                        if (timesOverlap(as, ae, cs, ce)) {
                            blockedBy = alloc.student.name;
                            break;
                        }
                    }
                }

                if (blockedBy) break;
            }

            if (blockedBy) blockedCount++;

            return {
                seatId: seat.id,
                label: seat.label,
                status: blockedBy ? "BLOCKED" as const : "AVAILABLE" as const,
                occupied: blockedBy !== null,
                occupiedBy: blockedBy,
            };
        });

        return NextResponse.json({
            multiShiftId,
            name: ms.name,
            totalSeats: seats.length,
            assignedCount,
            blockedCount,
            occupiedCount: assignedCount + blockedCount,
            availableCount: seats.length - assignedCount - blockedCount,
            seats: seatList,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal Server Error";
        if (message.includes("Unauthorized")) {
            return NextResponse.json({ error: message }, { status: 403 });
        }
        if (message.includes("not found")) {
            return NextResponse.json({ error: message }, { status: 404 });
        }
        console.error("[multi-shift seat-map]", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
