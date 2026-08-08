import { describe, expect, it } from "vitest";
import { buildTopSearchResults } from "@/lib/topSearch";
import { STAFF_ACTIONS, type StaffAction } from "@/types";

function permissions(allowed: StaffAction[]) {
    return STAFF_ACTIONS.reduce<Record<StaffAction, boolean>>((result, action) => {
        result[action] = allowed.includes(action);
        return result;
    }, {} as Record<StaffAction, boolean>);
}

const branchId = "branch_1";

describe("buildTopSearchResults", () => {
    it("ranks prefix and name matches before weaker matches", () => {
        const groups = buildTopSearchResults({
            branchId,
            query: "ra",
            access: { permissions: permissions(["students"]) },
            students: [
                { id: "s1", name: "Aarav Rao", phone: "99999", status: "ACTIVE" },
                { id: "s2", name: "Rahul Patel", phone: "88888", status: "ACTIVE" },
            ],
        });

        const students = groups.find(group => group.id === "students")?.results ?? [];

        expect(students.map(result => result.title)).toEqual(["Rahul Patel", "Aarav Rao"]);
    });

    it("filters record groups and actions by permissions", () => {
        const groups = buildTopSearchResults({
            branchId,
            query: "pay",
            access: { permissions: permissions(["students"]) },
            students: [{ id: "s1", name: "Payal Singh", phone: null, status: "ACTIVE" }],
            payments: [{
                id: "p1",
                amount: 1200,
                status: "DUE",
                type: "MONTHLY",
                dueDate: "2026-01-10T00:00:00.000Z",
                student: { name: "Rahul Patel", phone: "99999" },
            }],
        });

        expect(groups.some(group => group.id === "students")).toBe(true);
        expect(groups.some(group => group.id === "payments")).toBe(false);
        expect(groups.flatMap(group => group.results).some(result => result.title === "Payments")).toBe(false);
    });

    it("returns permitted quick actions for an empty focused search", () => {
        const groups = buildTopSearchResults({
            branchId,
            query: "",
            access: { permissions: permissions(["students", "seat_allocation", "view_payments"]) },
        });

        const actions = groups.find(group => group.id === "actions")?.results ?? [];

        expect(actions.map(action => action.title)).toEqual([
            "Add Student",
            "Assign Seat",
            "Seats & Maps",
            "Payments",
        ]);
        expect(groups).toHaveLength(1);
    });

    it("handles missing optional fields while matching available record data", () => {
        const groups = buildTopSearchResults({
            branchId,
            query: "due",
            access: {
                permissions: permissions([
                    "students",
                    "view_payments",
                    "seat_allocation",
                    "manage_branch",
                ]),
            },
            students: [{ id: "s1" }],
            payments: [{ id: "p1", status: "DUE", amount: null, dueDate: null, student: null }],
            seats: [{ id: "seat_1", label: "A1" }],
            shifts: [{ id: "shift_1", name: null, startTime: null, endTime: null, price: null }],
            staff: [{ id: "staff_1", role: "MANAGER", user: null }],
        });

        const payments = groups.find(group => group.id === "payments")?.results ?? [];

        expect(payments).toHaveLength(1);
        expect(payments[0]).toMatchObject({
            title: "Unknown student",
            href: `/branch/${branchId}/payments?paymentId=p1&status=DUE`,
        });
    });

    it("builds destination-aware record links", () => {
        const groups = buildTopSearchResults({
            branchId,
            query: "rahul",
            access: {
                permissions: permissions(["students", "view_payments", "seat_allocation", "manage_branch"]),
            },
            students: [{ id: "s1", name: "Rahul", status: "INACTIVE" }],
            payments: [{
                id: "p1",
                amount: 1200,
                status: "PAID",
                type: "MONTHLY",
                dueDate: "2026-03-10T00:00:00.000Z",
                student: { name: "Rahul" },
            }],
            seats: [{ id: "seat1", label: "A1", seatAllocations: [{ student: { name: "Rahul" } }] }],
            staff: [{ id: "staff1", role: "STAFF", user: { name: "Rahul" } }],
        });

        const hrefs = groups.flatMap(group => group.results.map(result => result.href));
        expect(hrefs).toContain(`/branch/${branchId}/students?studentId=s1&status=INACTIVE`);
        expect(hrefs).toContain(`/branch/${branchId}/payments?paymentId=p1&month=2026-03&status=PAID`);
        expect(hrefs).toContain(`/branch/${branchId}/seats?seatId=seat1`);
        expect(hrefs).toContain(`/branch/${branchId}/staff?staffId=staff1`);
    });

    it("only exposes payment generation when both page and action permissions are available", () => {
        const generateOnly = buildTopSearchResults({
            branchId,
            query: "generate",
            access: { permissions: permissions(["generate_payments"]) },
        });
        expect(generateOnly.flatMap(group => group.results)).toHaveLength(0);

        const permitted = buildTopSearchResults({
            branchId,
            query: "generate",
            access: { permissions: permissions(["view_payments", "generate_payments"]) },
        });
        expect(permitted.flatMap(group => group.results)[0]?.href)
            .toBe(`/branch/${branchId}/payments?generate=1`);
    });
});
