import { describe, expect, it } from "vitest";
import {
    getAtomicReleaseAllocationId,
    getMultiShiftBranchStatusCount,
    getUnloadedMultiShiftMatchCount,
} from "@/lib/seatViewState";
import type { MultiShiftSeatMap } from "@/types";

const map: MultiShiftSeatMap = {
    multiShiftId: "full_time",
    name: "Full Time",
    totalSeats: 4,
    assignedCount: 1,
    blockedCount: 1,
    occupiedCount: 2,
    availableCount: 2,
    seats: [
        { seatId: "seat_1", label: "1", status: "BLOCKED", occupied: true, occupiedBy: "Morning" },
        { seatId: "seat_2", label: "2", status: "AVAILABLE", occupied: false, occupiedBy: null },
        { seatId: "seat_3", label: "3", status: "ASSIGNED", occupied: true, occupiedBy: "Student" },
        { seatId: "seat_4", label: "4", status: "AVAILABLE", occupied: false, occupiedBy: null },
    ],
};

describe("multi-shift paginated seat view state", () => {
    it("uses one component ID for an atomic grouped bundle release", () => {
        expect(getAtomicReleaseAllocationId(["bundle_a", "bundle_b", "bundle_c"])).toBe("bundle_a");
        expect(getAtomicReleaseAllocationId("single")).toBe("single");
        expect(() => getAtomicReleaseAllocationId([])).toThrow(/at least one allocation/i);
    });

    it("uses branch-wide map counts rather than loaded-page counts", () => {
        expect(getMultiShiftBranchStatusCount(map, "ALL")).toBe(4);
        expect(getMultiShiftBranchStatusCount(map, "ALLOCATED")).toBe(1);
        expect(getMultiShiftBranchStatusCount(map, "BLOCKED")).toBe(1);
        expect(getMultiShiftBranchStatusCount(map, "AVAILABLE")).toBe(2);
    });

    it("detects matching statuses that exist only on later pages", () => {
        expect(getUnloadedMultiShiftMatchCount(map, ["seat_1", "seat_2"], "ALLOCATED")).toBe(1);
        expect(getUnloadedMultiShiftMatchCount(map, ["seat_1", "seat_2"], "AVAILABLE")).toBe(1);
        expect(getUnloadedMultiShiftMatchCount(map, ["seat_1", "seat_2"], "BLOCKED")).toBe(0);
        expect(getUnloadedMultiShiftMatchCount(map, ["seat_1", "seat_2"], "ALL")).toBe(2);
    });
});
