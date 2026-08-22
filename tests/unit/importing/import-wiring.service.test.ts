import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    branchFindUnique: vi.fn(),
    seatAllocationFindMany: vi.fn(),
    importSessionFindFirst: vi.fn(),
    getShiftsCapacityWithMulti: vi.fn(),
    getSeatMap: vi.fn(),
}));

vi.mock("@/services/staff.service", () => ({
    StaffService: {
        authorize: mocks.authorize,
    },
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
        branch: { findUnique: mocks.branchFindUnique },
        seatAllocation: { findMany: mocks.seatAllocationFindMany },
        importSession: { findFirst: mocks.importSessionFindFirst },
    },
}));

vi.mock("@/services/seat.service", () => ({
    SeatService: {
        getShiftsCapacityWithMulti: mocks.getShiftsCapacityWithMulti,
        getSeatMap: mocks.getSeatMap,
    },
}));

const branchContext = {
    defaultFee: 900,
    defaultAdmissionFee: 0,
    seats: [
        { id: "seat_1", label: "A1" },
        { id: "seat_2", label: "A2" },
    ],
    shifts: [
        { id: "shift_morning", name: "Morning", startTime: "09:00", endTime: "12:00", price: 1200 },
        { id: "shift_late", name: "Late Morning", startTime: "11:00", endTime: "14:00", price: 1300 },
    ],
    multiShifts: [],
    students: [],
};

const session = {
    id: "session_1",
    fileMeta: { columns: ["Name", "Seat", "Shift"] },
    mapping: {
        entityTypesDetected: ["STUDENT", "ALLOCATION"],
        columnMappings: [],
        importOptions: {
            paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
            paymentAction: "GENERATE_DUE",
        },
    },
    rows: [
        {
            id: "row_1",
            rowNumber: 2,
            status: "NEEDS_REVIEW",
            skipped: false,
            rawData: {},
            normalizedData: {
                student: { name: "Asha", monthlyFee: 1200, joinedAt: "2026-01-01T00:00:00.000Z", joinedAtSource: "UPLOADED" },
                allocation: { seatLabel: "A1", shiftName: "Morning" },
            },
        },
        {
            id: "row_2",
            rowNumber: 3,
            status: "READY",
            skipped: false,
            rawData: {},
            normalizedData: {
                student: { name: "Ravi", monthlyFee: 1200, joinedAt: "2026-01-01T00:00:00.000Z", joinedAtSource: "UPLOADED" },
                allocation: { seatLabel: "A1", shiftName: "Morning" },
            },
        },
    ],
};

describe("ImportWiringService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(true);
        mocks.branchFindUnique.mockResolvedValue(branchContext);
        mocks.seatAllocationFindMany.mockResolvedValue([]);
        mocks.importSessionFindFirst.mockResolvedValue(session);
        mocks.getShiftsCapacityWithMulti.mockResolvedValue([
            {
                type: "PRIMARY",
                shiftId: "shift_morning",
                name: "Morning",
                startTime: "09:00",
                endTime: "12:00",
                price: 1200,
                isReserved: false,
                totalSeats: 2,
                used: 0,
                available: 2,
                occupancyPercent: 0,
                isFull: false,
                studentAlreadyAllocated: false,
            },
        ]);
        mocks.getSeatMap.mockResolvedValue({
            shiftId: "shift_morning",
            shiftName: "Morning",
            isReserved: false,
            totalSeats: 2,
            occupiedCount: 0,
            availableCount: 2,
            seats: [
                { seatId: "seat_1", label: "A1", occupied: false, occupiedBy: null },
                { seatId: "seat_2", label: "A2", occupied: false, occupiedBy: null },
            ],
        });
    });

    it("previews selected-row conflicts against staged import rows", async () => {
        const { ImportWiringService } = await import("@/importing/services/import-wiring.service");

        const preview = await ImportWiringService.previewRowDraft("user_1", "branch_1", "session_1", {
            rowId: "row_1",
            normalizedData: {
                student: { name: "Asha", monthlyFee: 1200, joinedAt: "2026-01-01T00:00:00.000Z", joinedAtSource: "UPLOADED" },
                allocation: { seatLabel: "A1", shiftName: "Morning" },
            },
        });

        expect(preview.status).toBe("CONFLICT");
        expect(preview.issues.some(issue => issue.code === "STAGED_ALLOCATION_CONFLICT")).toBe(true);
        expect(preview.paymentPreview).toMatchObject({
            enabled: true,
            amount: 1200,
            amountSource: "MONTHLY_FEE",
        });
    });

    it("previews staged conflicts as manual follow-up when allocation deferral is enabled", async () => {
        mocks.importSessionFindFirst.mockResolvedValueOnce({
            ...session,
            mapping: {
                ...session.mapping,
                importOptions: {
                    ...session.mapping.importOptions,
                    skipConflictingAllocations: true,
                },
            },
        });
        const { ImportWiringService } = await import("@/importing/services/import-wiring.service");

        const preview = await ImportWiringService.previewRowDraft("user_1", "branch_1", "session_1", {
            rowId: "row_1",
            normalizedData: {
                student: { name: "Asha", monthlyFee: 1200, joinedAt: "2026-01-01T00:00:00.000Z", joinedAtSource: "UPLOADED" },
                allocation: { seatLabel: "A1", shiftName: "Morning" },
            },
        });

        expect(preview.status).toBe("WARNING");
        expect(preview.issues.some(issue => issue.code === "STAGED_ALLOCATION_CONFLICT")).toBe(false);
        expect(preview.warnings.some(issue => issue.code === "ALLOCATION_SKIPPED_STAGED_CONFLICT")).toBe(true);
    });

    it("overlays staged import rows on seat availability", async () => {
        const { ImportWiringService } = await import("@/importing/services/import-wiring.service");

        const availability = await ImportWiringService.getAvailability("user_1", "branch_1", "session_1", {
            rowId: "row_1",
            shiftIds: ["shift_morning"],
        });

        expect(availability.shifts[0]).toMatchObject({ stagedUsed: 1, available: 1 });
        expect(availability.seatMap?.seats.find(seat => seat.label === "A1")).toMatchObject({
            occupied: true,
            source: "staged",
            stagedRowNumber: 3,
        });
        expect(mocks.getSeatMap).toHaveBeenCalledWith("user_1", "branch_1", "shift_morning", undefined);
    });
});
