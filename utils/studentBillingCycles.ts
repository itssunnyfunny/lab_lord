import { addMonths, endOfMonth, isAfter, isBefore, startOfDay, startOfMonth } from "date-fns";

export type StudentBillingCycle = {
    index: number;
    periodStart: Date;
    periodEnd: Date;
    dueDate: Date;
};

function normalizeDate(value: Date) {
    return startOfDay(value);
}

export function studentBillingCycle(joinedAt: Date, index: number): StudentBillingCycle {
    const anchor = normalizeDate(joinedAt);
    const periodStart = normalizeDate(addMonths(anchor, index));
    const periodEnd = normalizeDate(addMonths(anchor, index + 1));

    return {
        index,
        periodStart,
        periodEnd,
        dueDate: periodEnd,
    };
}

export function dueCyclesThrough(
    joinedAt: Date,
    asOf: Date,
    billingStartAt?: Date | null
): StudentBillingCycle[] {
    const dueCutoff = normalizeDate(asOf);
    const billingStart = billingStartAt ? normalizeDate(billingStartAt) : null;
    const cycles: StudentBillingCycle[] = [];

    for (let index = 0; index < 600; index++) {
        const cycle = studentBillingCycle(joinedAt, index);
        if (isAfter(cycle.dueDate, dueCutoff)) break;

        if (!billingStart || !isBefore(cycle.periodStart, billingStart)) {
            cycles.push(cycle);
        }
    }

    return cycles;
}

export function currentMonthJoinedCycle(
    joinedAt: Date,
    asOf: Date
): StudentBillingCycle | null {
    const monthStart = startOfMonth(asOf);
    const monthEnd = endOfMonth(asOf);

    for (let index = 0; index < 600; index++) {
        const cycle = studentBillingCycle(joinedAt, index);
        if (isBefore(cycle.dueDate, monthStart)) continue;
        if (isAfter(cycle.dueDate, monthEnd)) return null;
        return cycle;
    }

    return null;
}

export function previousCyclesBefore(
    joinedAt: Date,
    dueDate: Date
): StudentBillingCycle[] {
    const cutoff = normalizeDate(dueDate);
    const cycles: StudentBillingCycle[] = [];

    for (let index = 0; index < 600; index++) {
        const cycle = studentBillingCycle(joinedAt, index);
        if (!isBefore(cycle.dueDate, cutoff)) break;
        cycles.push(cycle);
    }

    return cycles;
}

export function isCycleDue(cycle: StudentBillingCycle, asOf: Date) {
    return !isAfter(cycle.dueDate, normalizeDate(asOf));
}
