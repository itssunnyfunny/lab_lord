export type SeatAllocationFilters = {
    studentId?: string;
    shiftId?: string;
    activeOnly?: boolean;
    status?: "ACTIVE" | "ENDED";
};
