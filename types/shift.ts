export interface CreateShiftDto {
    name: string;
    startTime?: string;
    endTime?: string;
    price?: number;
    isReserved?: boolean;
}

/** A branch list can be scoped to every shift, one primary shift, or one exact multi-shift bundle. */
export type ShiftScope =
    | { kind: "all" }
    | { kind: "primary"; id: string }
    | { kind: "multi"; id: string };

export interface MultiShiftSummary {
    id: string;
    name: string;
    price: number;
    createdAt: string | Date;
    components: {
        shiftId: string;
        shiftName: string;
        startTime: string | null;
        endTime: string | null;
        order: number;
    }[];
}

export type MultiShiftSeatStatus = "ASSIGNED" | "BLOCKED" | "AVAILABLE";

export interface MultiShiftSeatMap {
    multiShiftId: string;
    name: string;
    totalSeats: number;
    assignedCount: number;
    blockedCount: number;
    occupiedCount: number;
    availableCount: number;
    seats: {
        seatId: string;
        label: string;
        status: MultiShiftSeatStatus;
        occupied: boolean;
        occupiedBy: string | null;
    }[];
}
