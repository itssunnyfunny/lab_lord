import { isSameDay, startOfDay } from "date-fns";
import type { PaymentStatus } from "@/app/generated/prisma/enums";
import type { ImportMappingState, ImportNormalizedRow, ImportOptions, PaymentHistoryMode } from "@/importing/contracts/import-session.contract";
import {
    currentMonthJoinedCycle,
    dueCyclesThrough,
    isCycleDue,
    previousCyclesBefore,
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

export function buildImportPaymentPlan(
    normalized: ImportNormalizedRow,
    mappingOrOptions: ImportMappingState | ImportOptions | undefined | null,
    asOf: Date = new Date()
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
            skippedHistoricalPayments: 0,
        };
    }

    const joinedStart = startOfDay(joinedAt);
    const currentCycle = currentMonthJoinedCycle(joinedStart, asOf);
    const statusForCurrent = currentStatus(normalized, options);

    if (historyMode === "FROM_JOINED_MARK_PAID") {
        const items = dueCyclesThrough(joinedStart, asOf).map(cycle =>
            itemFor(cycle, "PAID", currentCycle)
        );
        return { enabled: true, historyMode, billingStartAt: joinedStart, items, skippedHistoricalPayments: 0 };
    }

    if (historyMode === "FROM_JOINED_MARK_DUE") {
        const items = dueCyclesThrough(joinedStart, asOf).map(cycle =>
            itemFor(cycle, "DUE", currentCycle)
        );
        return { enabled: true, historyMode, billingStartAt: joinedStart, items, skippedHistoricalPayments: 0 };
    }

    if (historyMode === "FROM_JOINED_PAID_THROUGH_PREVIOUS") {
        const previousCycles = currentCycle
            ? previousCyclesBefore(joinedStart, currentCycle.dueDate)
            : dueCyclesThrough(joinedStart, asOf);
        const items = previousCycles.map(cycle => itemFor(cycle, "PAID", currentCycle));

        if (currentCycle && isCycleDue(currentCycle, asOf)) {
            items.push(itemFor(currentCycle, statusForCurrent, currentCycle));
        }

        return { enabled: true, historyMode, billingStartAt: joinedStart, items, skippedHistoricalPayments: 0 };
    }

    const previousCount = currentCycle
        ? previousCyclesBefore(joinedStart, currentCycle.dueDate).length
        : dueCyclesThrough(joinedStart, asOf).length;
    const items = currentCycle && isCycleDue(currentCycle, asOf)
        ? [itemFor(currentCycle, statusForCurrent, currentCycle)]
        : [];

    return {
        enabled: true,
        historyMode,
        billingStartAt: currentCycle?.periodStart ?? joinedStart,
        items,
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
