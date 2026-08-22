import { isAfter, isBefore, isSameDay, startOfDay } from "date-fns";
import type { PaymentStatus } from "@/app/generated/prisma/enums";
import type { ImportMappingState, ImportNormalizedRow, ImportOptions, PaymentHistoryMode } from "@/importing/contracts/import-session.contract";
import {
    currentMonthJoinedCycle,
    isCycleDue,
    studentBillingCycle,
    type StudentBillingCycle,
} from "@/utils/studentBillingCycles";

export const DEFAULT_PAYMENT_HISTORY_MODE: PaymentHistoryMode = "START_CURRENT_JOINED_CYCLE";

export type ImportPaymentPlanItem = {
    cycle: StudentBillingCycle;
    status: Exclude<PaymentStatus, "WAIVED"> | "WAIVED";
    bucket: "historical" | "current";
};

export type ImportPaymentPlan = {
    enabled: boolean;
    historyMode: PaymentHistoryMode;
    billingStartAt: Date | null;
    items: ImportPaymentPlanItem[];
    hasMoreItems: boolean;
    skippedHistoricalPayments: number;
};

export type ImportPaymentPlanSummary = {
    generatePayments: number;
    markPaid: number;
    markWaived: number;
    historicalPaid: number;
    historicalDue: number;
    currentCyclePayments: number;
    skippedHistoricalPayments: number;
};

export function importPaymentHistoryMode(options?: ImportOptions | null): PaymentHistoryMode {
    return options?.paymentHistoryMode ?? DEFAULT_PAYMENT_HISTORY_MODE;
}

function isPaymentEnabled(options?: ImportOptions | null) {
    return Boolean(
        options?.paymentAction &&
        options.paymentAction !== "SKIP_PAYMENTS" &&
        options.paymentCycle !== "SKIP_PAYMENTS"
    );
}

function currentStatus(normalized: ImportNormalizedRow, options?: ImportOptions | null): ImportPaymentPlanItem["status"] {
    if (options?.paymentAction === "IMPORT_PAID_UNPAID") {
        if (normalized.payment?.status === "PAID") return "PAID";
        if (normalized.payment?.status === "WAIVED") return "WAIVED";
    }

    return "DUE";
}

function itemFor(cycle: StudentBillingCycle, status: ImportPaymentPlanItem["status"], currentCycle: StudentBillingCycle | null): ImportPaymentPlanItem {
    return {
        cycle,
        status,
        bucket: currentCycle && isSameDay(cycle.dueDate, currentCycle.dueDate) ? "current" : "historical",
    };
}

type BoundedCycles = {
    cycles: StudentBillingCycle[];
    hasMore: boolean;
};

function boundedCycleLimit(value?: number) {
    if (value === undefined) return 600;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Import payment plan item limit must be a non-negative integer");
    }
    return Math.min(600, value);
}

function collectDueCycles(joinedAt: Date, asOf: Date, maxItems?: number): BoundedCycles {
    const cutoff = startOfDay(asOf);
    const limit = boundedCycleLimit(maxItems);
    const cycles: StudentBillingCycle[] = [];
    for (let index = 0; index < 600; index++) {
        const cycle = studentBillingCycle(joinedAt, index);
        if (isAfter(cycle.dueDate, cutoff)) return { cycles, hasMore: false };
        if (cycles.length >= limit) return { cycles, hasMore: true };
        cycles.push(cycle);
    }
    return { cycles, hasMore: false };
}

function collectPreviousCycles(joinedAt: Date, dueDate: Date, maxItems?: number): BoundedCycles {
    const cutoff = startOfDay(dueDate);
    const limit = boundedCycleLimit(maxItems);
    const cycles: StudentBillingCycle[] = [];
    for (let index = 0; index < 600; index++) {
        const cycle = studentBillingCycle(joinedAt, index);
        if (!isBefore(cycle.dueDate, cutoff)) return { cycles, hasMore: false };
        if (cycles.length >= limit) return { cycles, hasMore: true };
        cycles.push(cycle);
    }
    return { cycles, hasMore: false };
}

function countPreviousCycles(joinedAt: Date, dueDate: Date) {
    return collectPreviousCycles(joinedAt, dueDate).cycles.length;
}

export function buildImportPaymentPlan(
    normalized: ImportNormalizedRow,
    mappingOrOptions: ImportMappingState | ImportOptions | undefined | null,
    asOf: Date = new Date(),
    limits: { maxItems?: number } = {}
): ImportPaymentPlan {
    const options = "importOptions" in (mappingOrOptions ?? {})
        ? (mappingOrOptions as ImportMappingState).importOptions
        : mappingOrOptions as ImportOptions | undefined | null;
    const historyMode = importPaymentHistoryMode(options);
    const joinedAt = normalized.student?.joinedAt ? new Date(normalized.student.joinedAt) : null;

    if (!isPaymentEnabled(options) || !joinedAt || Number.isNaN(joinedAt.getTime())) {
        return {
            enabled: false,
            historyMode,
            billingStartAt: null,
            items: [],
            hasMoreItems: false,
            skippedHistoricalPayments: 0,
        };
    }

    const joinedStart = startOfDay(joinedAt);
    const currentCycle = currentMonthJoinedCycle(joinedStart, asOf);
    const statusForCurrent = currentStatus(normalized, options);

    if (historyMode === "FROM_JOINED_MARK_PAID") {
        const selected = collectDueCycles(joinedStart, asOf, limits.maxItems);
        const items = selected.cycles.map(cycle =>
            itemFor(cycle, "PAID", currentCycle)
        );
        return { enabled: true, historyMode, billingStartAt: joinedStart, items, hasMoreItems: selected.hasMore, skippedHistoricalPayments: 0 };
    }

    if (historyMode === "FROM_JOINED_MARK_DUE") {
        const selected = collectDueCycles(joinedStart, asOf, limits.maxItems);
        const items = selected.cycles.map(cycle =>
            itemFor(cycle, "DUE", currentCycle)
        );
        return { enabled: true, historyMode, billingStartAt: joinedStart, items, hasMoreItems: selected.hasMore, skippedHistoricalPayments: 0 };
    }

    if (historyMode === "FROM_JOINED_PAID_THROUGH_PREVIOUS") {
        const selected = currentCycle
            ? collectPreviousCycles(joinedStart, currentCycle.dueDate, limits.maxItems)
            : collectDueCycles(joinedStart, asOf, limits.maxItems);
        const items = selected.cycles.map(cycle => itemFor(cycle, "PAID", currentCycle));
        let hasMoreItems = selected.hasMore;

        if (currentCycle && isCycleDue(currentCycle, asOf)) {
            const limit = boundedCycleLimit(limits.maxItems);
            if (items.length < limit) items.push(itemFor(currentCycle, statusForCurrent, currentCycle));
            else hasMoreItems = true;
        }

        return { enabled: true, historyMode, billingStartAt: joinedStart, items, hasMoreItems, skippedHistoricalPayments: 0 };
    }

    const previousCount = currentCycle
        ? countPreviousCycles(joinedStart, currentCycle.dueDate)
        : collectDueCycles(joinedStart, asOf).cycles.length;
    const currentItem = currentCycle && isCycleDue(currentCycle, asOf)
        ? [itemFor(currentCycle, statusForCurrent, currentCycle)]
        : [];
    const limit = boundedCycleLimit(limits.maxItems);
    const items = currentItem.slice(0, limit);

    return {
        enabled: true,
        historyMode,
        billingStartAt: currentCycle?.periodStart ?? joinedStart,
        items,
        hasMoreItems: currentItem.length > items.length,
        skippedHistoricalPayments: previousCount,
    };
}

export function summarizeImportPaymentPlans(plans: ImportPaymentPlan[]): ImportPaymentPlanSummary {
    const items = plans.flatMap(plan => plan.items);

    return {
        generatePayments: items.length,
        markPaid: items.filter(item => item.status === "PAID").length,
        markWaived: items.filter(item => item.status === "WAIVED").length,
        historicalPaid: items.filter(item => item.bucket === "historical" && item.status === "PAID").length,
        historicalDue: items.filter(item => item.bucket === "historical" && item.status === "DUE").length,
        currentCyclePayments: items.filter(item => item.bucket === "current").length,
        skippedHistoricalPayments: plans.reduce((total, plan) => total + plan.skippedHistoricalPayments, 0),
    };
}
