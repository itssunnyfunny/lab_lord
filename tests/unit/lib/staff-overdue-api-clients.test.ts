import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
}));

vi.mock("@/lib/api/core", () => ({
    apiClient: {
        get: mocks.get,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
    },
}));

import { payments } from "@/lib/api/payments";
import { staff } from "@/lib/api/staff";

describe("staff and overdue API clients", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.get.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    });

    it("sends the staff cursor and limit without changing the invite endpoint", async () => {
        await staff.list("branch_1", { cursor: "opaque_staff", limit: 25 });

        expect(mocks.get).toHaveBeenCalledWith(
            "/branches/branch_1/staff?cursor=opaque_staff&limit=25"
        );
    });

    it("uses bounded overdue pages unless all is explicit", async () => {
        await payments.listOverdue("branch_1", { cursor: "opaque_due", limit: 50 });
        await payments.listOverdue("branch_1", { all: true });

        expect(mocks.get.mock.calls).toEqual([
            ["/branches/branch_1/payments/overdue?cursor=opaque_due&limit=50"],
            ["/branches/branch_1/payments/overdue?all=true"],
        ]);
    });
});
