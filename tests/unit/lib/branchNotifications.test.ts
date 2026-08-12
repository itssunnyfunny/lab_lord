import { describe, expect, it } from "vitest";
import { buildBranchNotifications } from "@/lib/branchNotifications";
import { STAFF_ACTIONS, type StaffAction } from "@/types";

function permissions(allowed: StaffAction[]) {
    return STAFF_ACTIONS.reduce<Record<StaffAction, boolean>>((result, action) => {
        result[action] = allowed.includes(action);
        return result;
    }, {} as Record<StaffAction, boolean>);
}

const branchId = "branch_1";

describe("buildBranchNotifications", () => {
    it("creates an overdue payment notification when payment access is allowed", () => {
        const notifications = buildBranchNotifications({
            branchId,
            access: { permissions: permissions(["view_payments"]) },
            overdue: {
                total: 2,
                nextCursor: null,
                items: [{
                    paymentId: "payment_1",
                    studentId: "student_1",
                    studentName: "Rahul Patel",
                    amount: 1200,
                    dueDate: "2026-01-10T00:00:00.000Z",
                }],
            },
        });

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
            kind: "overdue_payments",
            severity: "warning",
            href: `/branch/${branchId}/payments?paymentId=payment_1&studentId=student_1&status=DUE`,
            count: 2,
        });
        expect(notifications[0].readKey).toContain("overdue_payments:2");
        expect(notifications[0].message).toContain("Rahul Patel");
    });

    it("does not expose payment or invite notifications without permissions", () => {
        const notifications = buildBranchNotifications({
            branchId,
            access: { permissions: permissions(["students"]) },
            overdue: { total: 3, nextCursor: null, items: [] },
            staffInvites: [{ id: "invite_1", role: "STAFF", expiresAt: "2026-02-01T00:00:00.000Z" }],
        });

        expect(notifications).toEqual([]);
    });

    it("detects active students without active seat allocations", () => {
        const notifications = buildBranchNotifications({
            branchId,
            access: { permissions: permissions(["students", "seat_allocation"]) },
            students: [
                { id: "student_1", status: "ACTIVE" },
                { id: "student_2", status: "ACTIVE" },
                { id: "student_3", status: "INACTIVE" },
            ],
            allocations: [
                { id: "alloc_1", studentId: "student_1", endDate: null },
                { id: "alloc_2", studentId: "student_3", endDate: null },
            ],
        });

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
            kind: "students_without_seats",
            title: "1 active student without a seat",
            href: `/branch/${branchId}/allocations?studentId=student_2`,
        });
    });

    it("prefers full shift capacity over near-full capacity", () => {
        const notifications = buildBranchNotifications({
            branchId,
            access: { permissions: permissions(["seat_allocation"]) },
            shiftCapacities: [
                { name: "Morning", type: "PRIMARY", used: 9, available: 1, occupancyPercent: 90, isFull: false },
                { name: "Evening", type: "PRIMARY", used: 10, available: 0, occupancyPercent: 100, isFull: true },
                { name: "Full Day", type: "MULTISHIFT", used: 10, available: 0, occupancyPercent: 100, isFull: true },
            ],
        });

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
            kind: "shift_full",
            title: "1 shift at full capacity",
            href: `/branch/${branchId}/seats`,
        });
    });

    it("creates owner-only active invite notifications", () => {
        const notifications = buildBranchNotifications({
            branchId,
            access: { permissions: permissions(["staff_management"]) },
            staffInvites: [
                { id: "invite_1", role: "STAFF", expiresAt: "2026-02-01T00:00:00.000Z" },
                { id: "invite_2", role: "MANAGER", expiresAt: "2026-01-15T00:00:00.000Z" },
            ],
        });

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
            kind: "active_invites",
            title: "2 active staff invites",
            href: `/branch/${branchId}/staff`,
            count: 2,
        });
        expect(notifications[0].message).toContain("15 Jan 2026");
    });

    it("changes read keys when the underlying notification data changes", () => {
        const first = buildBranchNotifications({
            branchId,
            access: { permissions: permissions(["view_payments"]) },
            overdue: {
                total: 1,
                nextCursor: null,
                items: [{ paymentId: "payment_1", studentName: "Rahul", amount: 1200 }],
            },
        });
        const second = buildBranchNotifications({
            branchId,
            access: { permissions: permissions(["view_payments"]) },
            overdue: {
                total: 2,
                nextCursor: null,
                items: [
                    { paymentId: "payment_1", studentName: "Rahul", amount: 1200 },
                    { paymentId: "payment_2", studentName: "Aarav", amount: 900 },
                ],
            },
        });

        expect(first[0].readKey).not.toBe(second[0].readKey);
    });
});
