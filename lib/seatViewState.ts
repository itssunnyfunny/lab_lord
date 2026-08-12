import type { MultiShiftSeatMap, MultiShiftSeatStatus } from "@/types";

export type SeatStatusFilter = "ALL" | "ALLOCATED" | "BLOCKED" | "AVAILABLE";

export function getAtomicReleaseAllocationId(ids: string | string[]): string {
    const allocationId = Array.isArray(ids) ? ids[0] : ids;
    if (!allocationId) throw new Error("At least one allocation is required.");
    return allocationId;
}

function statusForFilter(filter: SeatStatusFilter): MultiShiftSeatStatus | null {
    if (filter === "ALLOCATED") return "ASSIGNED";
    if (filter === "BLOCKED") return "BLOCKED";
    if (filter === "AVAILABLE") return "AVAILABLE";
    return null;
}

export function getMultiShiftBranchStatusCount(
    seatMap: MultiShiftSeatMap,
    filter: SeatStatusFilter
): number {
    if (filter === "ALLOCATED") return seatMap.assignedCount;
    if (filter === "BLOCKED") return seatMap.blockedCount;
    if (filter === "AVAILABLE") return seatMap.availableCount;
    return seatMap.totalSeats;
}

export function getUnloadedMultiShiftMatchCount(
    seatMap: MultiShiftSeatMap,
    loadedSeatIds: Iterable<string>,
    filter: SeatStatusFilter
): number {
    const loaded = new Set(loadedSeatIds);
    const requiredStatus = statusForFilter(filter);

    return seatMap.seats.reduce((count, seat) => {
        if (loaded.has(seat.seatId)) return count;
        if (requiredStatus && seat.status !== requiredStatus) return count;
        return count + 1;
    }, 0);
}
