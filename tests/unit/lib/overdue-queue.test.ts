import { describe, expect, it } from "vitest";
import {
    getOverdueBulkReviewHref,
    getOverduePaymentHref,
    getOverdueStudentHref,
    updateQueueSelection,
} from "@/lib/overdueQueue";

const marchPayment = {
    paymentId: "pay/1",
    studentId: "student 1",
    dueDate: "2026-03-05T00:00:00.000Z",
};

describe("overdue queue navigation", () => {
    it("builds an exact canonical payment destination", () => {
        expect(getOverduePaymentHref("branch one", marchPayment)).toBe(
            "/branch/branch%20one/payments?paymentId=pay%2F1&studentId=student+1&month=2026-03&status=DUE"
        );
    });

    it("builds an exact student destination", () => {
        expect(getOverdueStudentHref("branch one", "student 1")).toBe(
            "/branch/branch%20one/students?studentId=student+1"
        );
    });

    it("reviews one payment exactly and groups same-month selections", () => {
        expect(getOverdueBulkReviewHref("branch", [marchPayment])).toContain("paymentId=pay%2F1");
        expect(getOverdueBulkReviewHref("branch", [
            marchPayment,
            { paymentId: "pay-2", studentId: "student-2", dueDate: "2026-03-20" },
        ])).toBe("/branch/branch/payments?month=2026-03&status=DUE");
    });

    it("uses the truthful due queue when selected payments span months", () => {
        expect(getOverdueBulkReviewHref("branch", [
            marchPayment,
            { paymentId: "pay-2", studentId: "student-2", dueDate: "2026-04-20" },
        ])).toBe("/branch/branch/payments?status=DUE");
    });
});

describe("overdue queue selection", () => {
    it("adds and removes only the requested visible payment ids", () => {
        const selected = new Set(["hidden", "visible-1"]);
        const allVisible = updateQueueSelection(selected, ["visible-1", "visible-2"], true);
        expect([...allVisible].sort()).toEqual(["hidden", "visible-1", "visible-2"]);

        const clearedVisible = updateQueueSelection(allVisible, ["visible-1", "visible-2"], false);
        expect([...clearedVisible]).toEqual(["hidden"]);
    });
});
