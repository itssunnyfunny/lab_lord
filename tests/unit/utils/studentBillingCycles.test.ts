import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import {
    currentMonthJoinedCycle,
    dueCyclesThrough,
    isCycleDue,
} from "@/utils/studentBillingCycles";

function day(value: Date) {
    return format(value, "yyyy-MM-dd");
}

describe("student billing cycles", () => {
    it("anchors cycle dates to the student's joined date", () => {
        const joinedAt = new Date("2026-01-12T00:00:00.000Z");
        const asOf = new Date("2026-07-03T00:00:00.000Z");

        const current = currentMonthJoinedCycle(joinedAt, asOf);

        expect(current && day(current.periodStart)).toBe("2026-06-12");
        expect(current && day(current.dueDate)).toBe("2026-07-12");
        expect(current && isCycleDue(current, asOf)).toBe(false);
    });

    it("does not generate future dues", () => {
        const joinedAt = new Date("2026-01-12T00:00:00.000Z");

        expect(dueCyclesThrough(joinedAt, new Date("2026-07-03T00:00:00.000Z")).map(cycle => day(cycle.dueDate))).toEqual([
            "2026-02-12",
            "2026-03-12",
            "2026-04-12",
            "2026-05-12",
            "2026-06-12",
        ]);
        expect(dueCyclesThrough(joinedAt, new Date("2026-07-12T00:00:00.000Z")).map(cycle => day(cycle.dueDate))).toContain("2026-07-12");
    });

    it("uses billingStartAt to skip historical catch-up", () => {
        const joinedAt = new Date("2026-01-12T00:00:00.000Z");
        const billingStartAt = new Date("2026-06-12T00:00:00.000Z");

        expect(dueCyclesThrough(joinedAt, new Date("2026-07-03T00:00:00.000Z"), billingStartAt)).toHaveLength(0);
        expect(dueCyclesThrough(joinedAt, new Date("2026-07-12T00:00:00.000Z"), billingStartAt).map(cycle => day(cycle.dueDate))).toEqual([
            "2026-07-12",
        ]);
    });
});
