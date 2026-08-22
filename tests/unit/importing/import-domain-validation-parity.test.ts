import { describe, expect, it, vi } from "vitest";
import type { ImportPlanSnapshot } from "@/importing/contracts/import-v2.contract";
import { assertImportPlanConfigurationCurrent } from "@/importing/services/import-plan-configuration.service";
import { validateRequiredImportFields } from "@/importing/validators/import-required-fields.validator";
import { validateImportSeat } from "@/importing/validators/import-seat.validator";
import { validateImportShift } from "@/importing/validators/import-shift.validator";

function snapshot(items: ImportPlanSnapshot["items"]): ImportPlanSnapshot {
    return {
        items,
        configurationApproval: {
            required: items.some(item => item.kind === "CONFIG"),
            approved: true,
            affectedRows: 1,
        },
    } as ImportPlanSnapshot;
}

function transaction(input: {
    seats?: Array<{ label: string }>;
    shifts?: Array<{
        name: string;
        startTime: string | null;
        endTime: string | null;
        price: number;
        isReserved: boolean;
    }>;
    multiShifts?: Array<{
        name: string;
        price: number;
        components: Array<{ shift: { name: string; branchId: string; status: string } }>;
    }>;
} = {}) {
    return {
        seat: { findMany: vi.fn().mockResolvedValue(input.seats ?? []) },
        shift: { findMany: vi.fn().mockResolvedValue(input.shifts ?? []) },
        multiShift: { findMany: vi.fn().mockResolvedValue(input.multiShifts ?? []) },
    };
}

const activeShifts = [
    { name: "Morning", startTime: "06:00", endTime: "10:00", price: 1200, isReserved: false },
    { name: "Afternoon", startTime: "10:00", endTime: "14:00", price: 1200, isReserved: false },
    { name: "Evening", startTime: "14:00", endTime: "18:00", price: 1200, isReserved: false },
];

function multiShiftConfig(name: string, componentShiftNames: string[]) {
    return {
        itemKey: `multi-shift-${name}`,
        kind: "CONFIG" as const,
        payload: { type: "multi-shift", name, componentShiftNames },
    };
}

describe("import validation parity with domain write services", () => {
    it("normalizes an 80-character student name and blocks 81 characters", () => {
        const acceptedRow = { student: { name: `  ${"A".repeat(39)}   ${"B".repeat(40)}  ` } };
        const accepted = validateRequiredImportFields(acceptedRow);
        const rejected = validateRequiredImportFields({ student: { name: "A".repeat(81) } });

        expect(accepted.issues).toEqual([]);
        expect(acceptedRow.student.name).toBe(`${"A".repeat(39)} ${"B".repeat(40)}`);
        expect(acceptedRow.student.name).toHaveLength(80);
        expect(rejected.issues).toContainEqual(expect.objectContaining({
            code: "INVALID_STUDENT_NAME",
            message: "Student name must be 80 characters or less.",
        }));
    });

    it("uses SeatService label rules before approving creation", () => {
        const acceptedRow = {
            seat: { label: "  A_1 / West  " },
            allocation: { seatLabel: "  A_1 / West  " },
        };
        const accepted = validateImportSeat(acceptedRow, {
            seatsByLabel: new Map(),
            createUnknownSeats: true,
        });
        const rejected = validateImportSeat({ seat: { label: "A#1" } }, {
            seatsByLabel: new Map(),
            createUnknownSeats: true,
        });

        expect(accepted.issues).toEqual([]);
        expect(acceptedRow.seat.label).toBe("A_1 / West");
        expect(accepted.warnings).toContainEqual(expect.objectContaining({ code: "WILL_CREATE_SEAT" }));
        expect(rejected.issues).toContainEqual(expect.objectContaining({ code: "INVALID_SEAT_LABEL" }));
        expect(rejected.warnings).toEqual([]);
    });

    it("uses the 50-character domain limit for planned shifts and multi-shifts", () => {
        const acceptedShift = validateImportShift({ shift: { name: "S".repeat(50) } }, {
            shiftsByName: new Map(),
            multiShiftsByName: new Map(),
            createUnknownShifts: true,
        });
        const rejectedShift = validateImportShift({ shift: { name: "S".repeat(51) } }, {
            shiftsByName: new Map(),
            multiShiftsByName: new Map(),
            createUnknownShifts: true,
        });
        const rejectedMultiShift = validateImportShift({ multiShift: { name: "M".repeat(51) } }, {
            shiftsByName: new Map(),
            multiShiftsByName: new Map(),
            createUnknownMultiShifts: true,
        });

        expect(acceptedShift.issues).toEqual([]);
        expect(acceptedShift.warnings).toContainEqual(expect.objectContaining({ code: "WILL_CREATE_SHIFT" }));
        expect(rejectedShift.issues).toContainEqual(expect.objectContaining({ code: "INVALID_SHIFT_NAME" }));
        expect(rejectedShift.warnings).toEqual([]);
        expect(rejectedMultiShift.issues).toContainEqual(expect.objectContaining({ code: "INVALID_MULTI_SHIFT_NAME" }));
        expect(rejectedMultiShift.warnings).toEqual([]);
    });
});

describe("immutable import plan domain validation", () => {
    it("accepts student and configuration labels at their service boundaries", async () => {
        const tx = transaction({
            shifts: [
                { name: "Morning", startTime: "06:00", endTime: "10:00", price: 1200, isReserved: false },
                { name: "Afternoon", startTime: "10:00", endTime: "14:00", price: 1200, isReserved: false },
            ],
        });
        const plan = snapshot([
            { itemKey: "seat", kind: "CONFIG", payload: { type: "seat", label: "A".repeat(32) } },
            {
                itemKey: "shift",
                kind: "CONFIG",
                payload: { type: "shift", name: "S".repeat(50), startTime: "14:00", endTime: "18:00" },
            },
            {
                itemKey: "multi-shift",
                kind: "CONFIG",
                payload: {
                    type: "multi-shift",
                    name: "M".repeat(50),
                    componentShiftNames: ["Morning", "Afternoon"],
                },
            },
            { itemKey: "student", kind: "STUDENT", payload: { student: { name: "N".repeat(80) } } },
        ]);

        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", plan))
            .resolves.toBeUndefined();
    });

    it.each([
        ["student", { itemKey: "student", kind: "STUDENT", payload: { student: { name: "N".repeat(81) } } }, "Student name must be 80 characters or less."],
        ["seat", { itemKey: "seat", kind: "CONFIG", payload: { type: "seat", label: "A#1" } }, "Seat label can use letters"],
        ["shift", { itemKey: "shift", kind: "CONFIG", payload: { type: "shift", name: "S".repeat(51) } }, "Shift name must be 50 characters or less."],
        ["multi-shift", { itemKey: "multi-shift", kind: "CONFIG", payload: { type: "multi-shift", name: "M".repeat(51) } }, "Multi-shift name must be 50 characters or less."],
    ] as const)("rejects an invalid planned %s label before execution", async (_label, item, message) => {
        await expect(assertImportPlanConfigurationCurrent(
            transaction() as never,
            "branch_1",
            snapshot([item as ImportPlanSnapshot["items"][number]])
        )).rejects.toThrow(message);
    });
});

describe("approved multi-shift creation parity", () => {
    it("requires at least two component shifts", async () => {
        await expect(assertImportPlanConfigurationCurrent(
            transaction({ shifts: activeShifts }) as never,
            "branch_1",
            snapshot([multiShiftConfig("Single", ["Morning"])])
        )).rejects.toThrow("at least 2 distinct primary shifts");
    });

    it("rejects a repeated component shift", async () => {
        await expect(assertImportPlanConfigurationCurrent(
            transaction({ shifts: activeShifts }) as never,
            "branch_1",
            snapshot([multiShiftConfig("Repeated", ["Morning", "Morning"])])
        )).rejects.toThrow("component shifts must be distinct");
    });

    it("rejects an order-independent duplicate of an existing active multi-shift", async () => {
        const existingComponents = ["Morning", "Afternoon"].map(name => ({
            shift: { name, branchId: "branch_1", status: "ACTIVE" },
        }));

        await expect(assertImportPlanConfigurationCurrent(
            transaction({
                shifts: activeShifts,
                multiShifts: [{ name: "Day", price: 2400, components: existingComponents }],
            }) as never,
            "branch_1",
            snapshot([multiShiftConfig("Day Plus", ["Afternoon", "Morning"])])
        )).rejects.toThrow('existing multi-shift "Day" uses the same primary shifts');
    });

    it("rejects an order-independent duplicate within the planned creation batch", async () => {
        await expect(assertImportPlanConfigurationCurrent(
            transaction({ shifts: activeShifts }) as never,
            "branch_1",
            snapshot([
                multiShiftConfig("Day One", ["Morning", "Afternoon"]),
                multiShiftConfig("Day Two", ["Afternoon", "Morning"]),
            ])
        )).rejects.toThrow('planned multi-shift "Day One" uses the same primary shifts');
    });

    it("accepts a distinct component combination", async () => {
        const existingComponents = ["Morning", "Afternoon"].map(name => ({
            shift: { name, branchId: "branch_1", status: "ACTIVE" },
        }));

        await expect(assertImportPlanConfigurationCurrent(
            transaction({
                shifts: activeShifts,
                multiShifts: [{ name: "Day", price: 2400, components: existingComponents }],
            }) as never,
            "branch_1",
            snapshot([multiShiftConfig("Split", ["Morning", "Evening"])])
        )).resolves.toBeUndefined();
    });
});
