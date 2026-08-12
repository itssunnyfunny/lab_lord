import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeDateIdCursor } from "@/lib/cursorPagination";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    listStaffPage: vi.fn(),
    assertBranchAccess: vi.fn(),
    getOverduePaymentsPage: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
    getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/staff.service", () => ({
    StaffService: {
        listStaffPage: mocks.listStaffPage,
    },
}));

vi.mock("@/services/payment.service", () => ({
    PaymentService: {
        assertBranchAccess: mocks.assertBranchAccess,
    },
}));

vi.mock("@/analytics/payment.analytics", () => ({
    getOverduePaymentsPage: mocks.getOverduePaymentsPage,
}));

const context = { params: Promise.resolve({ branchId: "branch_1" }) };
const emptyPage = { items: [], nextCursor: null, total: 0 };

describe("staff and overdue pagination routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionUser.mockResolvedValue({ id: "owner_1" });
        mocks.listStaffPage.mockResolvedValue(emptyPage);
        mocks.assertBranchAccess.mockResolvedValue({ id: "branch_1" });
        mocks.getOverduePaymentsPage.mockResolvedValue(emptyPage);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("uses the default staff page size and PagedResult contract", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/staff/route");
        const request = new NextRequest("http://test.local/api/branches/branch_1/staff");

        const response = await GET(request, context);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(emptyPage);
        expect(mocks.listStaffPage).toHaveBeenCalledWith("owner_1", "branch_1", {
            cursor: null,
            limit: 50,
        });
    });

    it("decodes a stable staff cursor and rejects invalid limits", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/staff/route");
        const cursor = encodeDateIdCursor({
            sort: "2026-08-08T09:00:00.000Z",
            id: "staff_50",
        });
        const valid = new NextRequest(
            `http://test.local/api/branches/branch_1/staff?limit=25&cursor=${cursor}`
        );

        expect((await GET(valid, context)).status).toBe(200);
        expect(mocks.listStaffPage).toHaveBeenLastCalledWith("owner_1", "branch_1", {
            cursor: { sort: new Date("2026-08-08T09:00:00.000Z"), id: "staff_50" },
            limit: 25,
        });

        mocks.listStaffPage.mockClear();
        const invalid = new NextRequest(
            "http://test.local/api/branches/branch_1/staff?limit=101"
        );
        const invalidResponse = await GET(invalid, context);
        expect(invalidResponse.status).toBe(400);
        expect(mocks.listStaffPage).not.toHaveBeenCalled();
    });

    it("returns a bounded overdue page after payment authorization", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/payments/overdue/route");
        const request = new NextRequest(
            "http://test.local/api/branches/branch_1/payments/overdue?limit=20"
        );

        const response = await GET(request, context);

        expect(response.status).toBe(200);
        expect(mocks.assertBranchAccess).toHaveBeenCalledWith(
            "owner_1",
            "branch_1",
            "view_payments"
        );
        expect(mocks.getOverduePaymentsPage).toHaveBeenCalledWith("branch_1", {
            cursor: null,
            limit: 20,
            all: false,
        });
    });

    it("supports explicit complete overdue reads without silently applying 50", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/payments/overdue/route");
        const request = new NextRequest(
            "http://test.local/api/branches/branch_1/payments/overdue?all=true"
        );

        expect((await GET(request, context)).status).toBe(200);
        expect(mocks.getOverduePaymentsPage).toHaveBeenCalledWith("branch_1", {
            cursor: null,
            limit: undefined,
            all: true,
        });
    });

    it("rejects malformed overdue cursors and ambiguous all requests", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/payments/overdue/route");

        const malformed = new NextRequest(
            "http://test.local/api/branches/branch_1/payments/overdue?cursor=not-a-cursor"
        );
        expect((await GET(malformed, context)).status).toBe(400);

        const ambiguous = new NextRequest(
            "http://test.local/api/branches/branch_1/payments/overdue?all=true&limit=10"
        );
        expect((await GET(ambiguous, context)).status).toBe(400);
        expect(mocks.getOverduePaymentsPage).not.toHaveBeenCalled();
    });
});
