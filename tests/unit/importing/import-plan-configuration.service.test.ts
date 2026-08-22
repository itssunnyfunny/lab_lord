import { describe, expect, it, vi } from "vitest";
import type { ImportPlanSnapshot } from "@/importing/contracts/import-v2.contract";
import {
    assertImportPlanConfigurationCurrent,
    reusableSucceededConfigurationItemKeys,
} from "@/importing/services/import-plan-configuration.service";

function snapshot(items: ImportPlanSnapshot["items"], approved = false) {
    return {
        items,
        configurationApproval: {
            required: items.some(item => item.kind === "CONFIG"),
            approved,
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

describe("import plan current configuration", () => {
    it("accepts branch-owned allocation references and an unchanged fee-linked price", async () => {
        const tx = transaction({
            seats: [{ label: "A1" }],
            shifts: [{ name: "Morning", startTime: "06:00", endTime: "10:00", price: 1200, isReserved: false }],
        });
        const plan = snapshot([
            {
                itemKey: "student",
                kind: "STUDENT",
                payload: { student: { name: "Asha", monthlyFee: 1200, feeLinkedShiftName: "Morning" } },
            },
            {
                itemKey: "allocation",
                kind: "ALLOCATION",
                payload: { allocation: { seatLabel: "A1", shiftName: "Morning" } },
            },
        ]);

        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", plan)).resolves.toBeUndefined();
    });

    it("rejects a fee-linked shift whose current price differs from the reviewed student fee", async () => {
        const tx = transaction({
            shifts: [{ name: "Morning", startTime: null, endTime: null, price: 1500, isReserved: false }],
        });
        const plan = snapshot([{
            itemKey: "student",
            kind: "STUDENT",
            payload: { student: { name: "Asha", monthlyFee: 1200, feeLinkedShiftName: "Morning" } },
        }]);

        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", plan))
            .rejects.toThrow("changed price");
    });

    it("rejects an allocation when its multi-shift component structure changed after review", async () => {
        const tx = transaction({
            seats: [{ label: "A1" }],
            multiShifts: [{
                name: "Full day",
                price: 2400,
                components: [
                    { shift: { name: "Morning", branchId: "branch_1", status: "ACTIVE" } },
                    { shift: { name: "Afternoon", branchId: "branch_1", status: "ACTIVE" } },
                ],
            }],
        });
        const plan = snapshot([{
            itemKey: "allocation",
            kind: "ALLOCATION",
            payload: {
                allocation: {
                    seatLabel: "A1",
                    multiShiftName: "Full day",
                    componentShiftNames: ["Morning", "Evening"],
                },
            },
        }]);

        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", plan))
            .rejects.toThrow("changed components");
    });

    it("allows an unavailable object only when its matching CONFIG item was approved", async () => {
        const tx = transaction();
        const items: ImportPlanSnapshot["items"] = [
            { itemKey: "config-seat", kind: "CONFIG", payload: { type: "seat", label: "A1" } },
            { itemKey: "student", kind: "STUDENT", payload: { student: { name: "Asha" } } },
            { itemKey: "allocation", kind: "ALLOCATION", payload: { allocation: { seatLabel: "A1" } } },
        ];

        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", snapshot(items, false)))
            .rejects.toThrow("seat \"A1\" is unavailable");
        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", snapshot(items, true)))
            .resolves.toBeUndefined();
    });

    it("rejects an approved missing shift that overlaps an existing active shift", async () => {
        const tx = transaction({
            shifts: [{
                name: "Morning",
                startTime: "06:00",
                endTime: "10:00",
                price: 1200,
                isReserved: false,
            }],
        });
        const plan = snapshot([{
            itemKey: "config-shift-afternoon",
            kind: "CONFIG",
            payload: {
                type: "shift",
                name: "Afternoon",
                startTime: "09:30",
                endTime: "13:00",
                price: 1200,
            },
        }], true);

        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", plan))
            .rejects.toThrow('shift "Afternoon" because it overlaps active shift "Morning"');
    });

    it("rejects overlapping shifts within one approved configuration batch", async () => {
        const tx = transaction();
        const plan = snapshot([
            {
                itemKey: "config-shift-late",
                kind: "CONFIG",
                payload: {
                    type: "shift",
                    name: "Late",
                    startTime: "22:00",
                    endTime: "04:00",
                    price: 1200,
                },
            },
            {
                itemKey: "config-shift-early",
                kind: "CONFIG",
                payload: {
                    type: "shift",
                    name: "Early",
                    startTime: "03:30",
                    endTime: "06:00",
                    price: 1200,
                },
            },
        ], true);

        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", plan))
            .rejects.toThrow('shifts "Late" and "Early" because their times overlap');
    });

    it("accepts adjacent existing and planned shift windows", async () => {
        const tx = transaction({
            shifts: [{
                name: "Morning",
                startTime: "06:00",
                endTime: "10:00",
                price: 1200,
                isReserved: false,
            }],
        });
        const plan = snapshot([
            {
                itemKey: "config-shift-afternoon",
                kind: "CONFIG",
                payload: {
                    type: "shift",
                    name: "Afternoon",
                    startTime: "10:00",
                    endTime: "14:00",
                    price: 1200,
                },
            },
            {
                itemKey: "config-shift-evening",
                kind: "CONFIG",
                payload: {
                    type: "shift",
                    name: "Evening",
                    startTime: "14:00",
                    endTime: "18:00",
                    price: 1200,
                },
            },
        ], true);

        await expect(assertImportPlanConfigurationCurrent(tx as never, "branch_1", plan))
            .resolves.toBeUndefined();
    });

    it("reuses a succeeded CONFIG key only while its retained entity still matches", async () => {
        const item = {
            itemKey: "config:shift:morning",
            kind: "CONFIG" as const,
            payload: {
                type: "shift",
                name: "Morning",
                startTime: "06:00",
                endTime: "10:00",
                price: 1200,
            },
        };
        const success = [{
            itemKey: item.itemKey,
            kind: "CONFIG" as const,
            rowId: "row_1",
            entityIds: ["shift_1"],
            requestHash: "retained-semantic-hash",
        }];
        const matching = transaction({
            shifts: [{
                id: "shift_1",
                name: "Morning",
                startTime: "06:00",
                endTime: "10:00",
                price: 1200,
                isReserved: false,
            }] as never,
        });
        const deleted = transaction();

        await expect(reusableSucceededConfigurationItemKeys(
            matching as never,
            "branch_1",
            snapshot([item]),
            success
        )).resolves.toEqual([item.itemKey]);
        await expect(reusableSucceededConfigurationItemKeys(
            deleted as never,
            "branch_1",
            snapshot([item]),
            success
        )).resolves.toEqual([]);
    });
});
