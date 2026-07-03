import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import { buildImportPaymentPlan, summarizeImportPaymentPlans } from "@/importing/utils/import-payment-plan";
import type { ImportOptions } from "@/importing/contracts/import-session.contract";

const baseOptions: ImportOptions = {
    paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
    paymentAction: "GENERATE_DUE",
};

const normalized = {
    student: {
        name: "Asha",
        joinedAt: "2026-01-12T00:00:00.000Z",
        monthlyFee: 1200,
    },
};

function day(value: Date | null) {
    return value ? format(value, "yyyy-MM-dd") : null;
}

describe("import payment plan", () => {
    it("defaults to the current joined-date cycle and skips old history", () => {
        const plan = buildImportPaymentPlan(normalized, baseOptions, new Date("2026-07-03T00:00:00.000Z"));

        expect(plan.items).toHaveLength(0);
        expect(plan.skippedHistoricalPayments).toBe(5);
        expect(day(plan.billingStartAt)).toBe("2026-06-12");
    });

    it("creates the current joined-date cycle once it is due", () => {
        const plan = buildImportPaymentPlan(normalized, baseOptions, new Date("2026-07-12T00:00:00.000Z"));

        expect(plan.items).toHaveLength(1);
        expect(day(plan.items[0].cycle.dueDate)).toBe("2026-07-12");
        expect(plan.items[0]).toMatchObject({ bucket: "current", status: "DUE" });
    });

    it("can mark all due cycles from joined date as paid", () => {
        const plan = buildImportPaymentPlan(
            normalized,
            { ...baseOptions, paymentHistoryMode: "FROM_JOINED_MARK_PAID" },
            new Date("2026-07-12T00:00:00.000Z")
        );
        const summary = summarizeImportPaymentPlans([plan]);

        expect(summary.generatePayments).toBe(6);
        expect(summary.markPaid).toBe(6);
        expect(summary.historicalPaid).toBe(5);
        expect(summary.currentCyclePayments).toBe(1);
    });

    it("marks previous cycles paid and handles the current cycle separately", () => {
        const plan = buildImportPaymentPlan(
            {
                ...normalized,
                payment: { status: "PAID" as const },
            },
            {
                paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
                paymentAction: "IMPORT_PAID_UNPAID",
                paymentHistoryMode: "FROM_JOINED_PAID_THROUGH_PREVIOUS",
            },
            new Date("2026-07-12T00:00:00.000Z")
        );
        const summary = summarizeImportPaymentPlans([plan]);

        expect(summary.historicalPaid).toBe(5);
        expect(summary.currentCyclePayments).toBe(1);
        expect(summary.markPaid).toBe(6);
    });
});
