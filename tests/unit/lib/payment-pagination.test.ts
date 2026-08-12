import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeDateIdCursor } from "@/lib/cursorPagination";

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
    count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
        payment: {
            findMany: mocks.findMany,
            count: mocks.count,
        },
    },
}));

import { getOverduePaymentsPage } from "@/analytics/payment.analytics";

function row(id: string, dueDate: Date) {
    return {
        id,
        studentId: `student_${id}`,
        dueDate,
        amount: 1200,
        student: { name: `Student ${id}`, phone: null },
    };
}

describe("getOverduePaymentsPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.count.mockResolvedValue(7);
    });

    it("uses dueDate/id ordering, look-ahead, and an opaque next cursor", async () => {
        const dueDate = new Date(2026, 5, 1);
        mocks.findMany.mockResolvedValue([
            row("payment_1", dueDate),
            row("payment_2", dueDate),
            row("payment_3", new Date(2026, 5, 2)),
        ]);

        const result = await getOverduePaymentsPage("branch_1", {
            asOf: new Date(2026, 7, 8, 12),
            limit: 2,
        });

        expect(result.items.map(item => item.paymentId)).toEqual(["payment_1", "payment_2"]);
        expect(result.total).toBe(7);
        expect(decodeDateIdCursor(result.nextCursor)).toEqual({
            sort: dueDate,
            id: "payment_2",
        });
        expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
            orderBy: [{ dueDate: "asc" }, { id: "asc" }],
            take: 3,
        }));
        expect(mocks.count).toHaveBeenCalledWith({
            where: {
                branchId: "branch_1",
                status: "DUE",
                dueDate: { lt: new Date(2026, 7, 1) },
            },
        });
    });

    it("applies the compound cursor while keeping total scoped to the full queue", async () => {
        mocks.findMany.mockResolvedValue([]);
        const cursor = {
            sort: new Date("2026-06-01T00:00:00.000Z"),
            id: "payment_50",
        };

        const result = await getOverduePaymentsPage("branch_1", {
            asOf: new Date(2026, 7, 8, 12),
            cursor,
            limit: 50,
        });

        expect(result).toEqual({ items: [], nextCursor: null, total: 7 });
        expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                branchId: "branch_1",
                status: "DUE",
                dueDate: { lt: new Date(2026, 7, 1) },
                OR: [
                    { dueDate: { gt: cursor.sort } },
                    { dueDate: cursor.sort, id: { gt: cursor.id } },
                ],
            },
            take: 51,
        }));
    });

    it("only performs an unbounded read when all is explicit", async () => {
        mocks.findMany.mockResolvedValue([row("payment_1", new Date(2026, 5, 1))]);

        const result = await getOverduePaymentsPage("branch_1", {
            asOf: new Date(2026, 7, 8, 12),
            all: true,
        });

        expect(result).toMatchObject({ nextCursor: null, total: 7 });
        expect(mocks.findMany.mock.calls[0][0]).not.toHaveProperty("take");
    });
});
