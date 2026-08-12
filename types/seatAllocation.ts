export type SeatAllocationFilters = {
    studentId?: string;
    shiftId?: string;
    multiShiftId?: string;
    activeOnly?: boolean;
    status?: "ACTIVE" | "ENDED";
};
