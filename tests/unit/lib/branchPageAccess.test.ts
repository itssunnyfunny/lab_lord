import { describe, expect, it } from "vitest";
import { BRANCH_PAGE_ACCESS, hasBranchPageAccess } from "@/lib/branchPageAccess";
import { STAFF_ACTIONS, type StaffAction } from "@/types";

function permissions(allowed: StaffAction[]) {
    return STAFF_ACTIONS.reduce<Record<StaffAction, boolean>>((result, action) => {
        result[action] = allowed.includes(action);
        return result;
    }, {} as Record<StaffAction, boolean>);
}

describe("branch page access mapping", () => {
    it("maps restricted pages to their effective staff permission", () => {
        expect(BRANCH_PAGE_ACCESS.analytics).toBe("analytics");
        expect(BRANCH_PAGE_ACCESS.settings).toEqual({
            anyOf: [
                "manage_branch",
                ["view_whatsapp", "receive_whatsapp_reports", "view_payments", "analytics"],
            ],
        });
        expect(BRANCH_PAGE_ACCESS.staff).toBe("manage_branch");
        expect(BRANCH_PAGE_ACCESS.shifts).toBe("seat_allocation");
        expect(BRANCH_PAGE_ACCESS.seats).toBe("seat_allocation");
        expect(BRANCH_PAGE_ACCESS.payments).toBe("view_payments");
        expect(BRANCH_PAGE_ACCESS.overdue).toBe("view_payments");
        expect(BRANCH_PAGE_ACCESS.students).toBe("students");
        expect(BRANCH_PAGE_ACCESS.allocations).toBe("seat_allocation");
        expect(BRANCH_PAGE_ACCESS).not.toHaveProperty("aiInsights");
        expect(BRANCH_PAGE_ACCESS.aiReports).toBe("analytics");
        expect(BRANCH_PAGE_ACCESS.aiMessages).toEqual(["analytics", "view_payments"]);
    });

    it("uses the effective permission result instead of role names", () => {
        const access = { permissions: permissions(["seat_allocation"]) };

        expect(hasBranchPageAccess(access, "seats")).toBe(true);
        expect(hasBranchPageAccess(access, "allocations")).toBe(true);
        expect(hasBranchPageAccess(access, "settings")).toBe(false);
    });

    it("requires every permission configured for a page", () => {
        expect(hasBranchPageAccess({ permissions: permissions(["analytics"]) }, "aiMessages")).toBe(false);
        expect(hasBranchPageAccess({ permissions: permissions(["analytics", "view_payments"]) }, "aiMessages")).toBe(true);
    });

    it("lets an exact report recipient reach settings without manage_branch", () => {
        const reportRecipient = permissions([
            "view_whatsapp",
            "receive_whatsapp_reports",
            "view_payments",
            "analytics",
        ]);

        expect(hasBranchPageAccess({ permissions: reportRecipient }, "settings")).toBe(true);
        expect(hasBranchPageAccess({
            permissions: { ...reportRecipient, analytics: false },
        }, "settings")).toBe(false);
    });

    it("denies access when no branch access payload is available", () => {
        expect(hasBranchPageAccess(null, "payments")).toBe(false);
        expect(hasBranchPageAccess(undefined, "analytics")).toBe(false);
    });
});
