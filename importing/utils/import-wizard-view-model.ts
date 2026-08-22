import type {
    ImportAITrace,
    ImportColumnMapping,
    ImportNormalizedRow,
    ImportOptions,
    ImportSessionSummary,
} from "@/importing/contracts/import-session.contract";
import type { ImportReadinessPolicy } from "@/importing/contracts/import-v2.contract";

export type ImportWizardStepId = "columns" | "rows" | "decisions" | "payments" | "preview" | "result";
export type ImportWizardStepState = "completed" | "needs_attention" | "pending";
export type ImportWizardTone = "success" | "warning" | "danger" | "default" | "cyan" | "purple";

export type ImportWizardStep = {
    id: ImportWizardStepId;
    label: string;
    state: ImportWizardStepState;
    count?: number;
    detail: string;
};

export type ImportWizardDetailLike = {
    status?: string;
    mapping?: {
        columnMappings?: ImportColumnMapping[];
        importOptions?: ImportOptions;
        usedFallback?: boolean;
        analysis?: {
            ai?: ImportAITrace;
            detectedPaymentValues?: string[];
        };
    } | null;
    summary?: Pick<
        ImportSessionSummary,
        | "readyRows"
        | "warningRows"
        | "needsReviewRows"
        | "blockedRows"
        | "duplicateRows"
        | "conflictRows"
        | "skippedRows"
        | "detectedEntityCounts"
    > | null;
    questions?: { status: string }[];
    commits?: unknown[];
};

export const IMPORT_WIZARD_STEPS: Array<{ id: ImportWizardStepId; label: string }> = [
    { id: "columns", label: "Columns" },
    { id: "decisions", label: "Decisions" },
    { id: "rows", label: "Rows" },
    { id: "payments", label: "Payments" },
    { id: "preview", label: "Preview" },
    { id: "result", label: "Result" },
];

export const importStatusLabels: Record<string, string> = {
    UPLOADED: "Uploaded",
    ANALYZING: "Analyzing",
    NEEDS_MAPPING: "Needs mapping",
    NEEDS_INFO: "Needs info",
    VALIDATED: "Validated",
    READY_TO_COMMIT: "Ready",
    COMMITTING: "Importing",
    COMMITTED: "Committed",
    PARTIAL: "Partial",
    FAILED: "Failed",
    CANCELLED: "Cancelled",
    READY: "Ready",
    NEEDS_REVIEW: "Needs review",
    WARNING: "Warning",
    BLOCKED: "Blocked",
    DUPLICATE: "Possible duplicate",
    CONFLICT: "Conflict",
    SKIPPED: "Skipped",
    IMPORTED: "Imported",
    QUEUED: "Queued",
    RUNNING: "Running",
    WAITING_FOR_USER: "Waiting for confirmation",
    COMPLETED: "Completed",
    COMPLETED_WITH_ISSUES: "Completed with issues",
    RETRYABLE_FAILURE: "Retry available",
    PERMANENT_FAILURE: "Failed",
    CANCEL_REQUESTED: "Cancelling",
    SUPERSEDED: "Replaced by newer run",
};

export const importOptionLabels: Record<string, string> = {
    USE_JOINED_AT_ANNIVERSARY: "Joined date cycle",
    SKIP_PAYMENTS: "Skip payments",
    GENERATE_DUE: "Generate due payments",
    IMPORT_PAID_UNPAID: "Import paid/unpaid",
    START_CURRENT_JOINED_CYCLE: "Start current joined cycle",
    FROM_JOINED_MARK_PAID: "From joined date, mark paid",
    FROM_JOINED_MARK_DUE: "From joined date, mark due",
    FROM_JOINED_PAID_THROUGH_PREVIOUS: "Paid through previous cycle",
    CASH: "Cash",
    UPI: "UPI",
    BANK_TRANSFER: "Bank transfer",
    YES_CREATE_SEATS: "Create missing seats",
    SKIP_UNKNOWN_SEAT_ALLOCATION: "Skip unknown seat link",
    CREATE_SHIFT: "Create missing shift",
    SKIP_UNKNOWN_SHIFT_ALLOCATION: "Skip unknown shift link",
    CREATE_MULTI_SHIFT: "Create missing bundle",
    SKIP_UNKNOWN_MULTI_SHIFT_ALLOCATION: "Skip unknown bundle link",
    SKIP_ALLOCATIONS: "Skip allocation links",
    SKIP_MISSING_SHIFT_ALLOCATION: "Skip missing shift link",
};

export function labelImportStatus(status: string | undefined | null) {
    if (!status) return "Unknown";
    return importStatusLabels[status] ?? status.replace(/_/g, " ").toLowerCase();
}

export function labelImportOption(value: string) {
    return importOptionLabels[value] ?? value.replace(/_/g, " ").toLowerCase();
}

export function statusTone(status: string | undefined | null): ImportWizardTone {
    if (!status) return "default";
    if (["READY", "READY_TO_COMMIT", "IMPORTED", "COMMITTED", "SUCCESS", "COMPLETED"].includes(status)) return "success";
    if (["WARNING", "NEEDS_REVIEW", "DUPLICATE", "VALIDATED", "NEEDS_INFO", "PARTIAL", "COMPLETED_WITH_ISSUES", "RETRYABLE_FAILURE", "CANCEL_REQUESTED"].includes(status)) return "warning";
    if (["BLOCKED", "CONFLICT", "FAILED", "PERMANENT_FAILURE"].includes(status)) return "danger";
    if (["SKIPPED", "CANCELLED", "SUPERSEDED"].includes(status)) return "default";
    return "cyan";
}

export function planCheckTone(status: string): ImportWizardTone {
    if (status === "pass") return "success";
    if (status === "warning") return "warning";
    if (status === "block") return "danger";
    return "default";
}

export function splitImportValues(value: string) {
    return value
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
}

export function joinImportValues(values: string[] | undefined | null) {
    return (values ?? []).join(", ");
}

export function paymentSkipOptions(): Partial<ImportOptions> {
    return {
        paymentCycle: "SKIP_PAYMENTS",
        paymentAction: "SKIP_PAYMENTS",
    };
}

export function paymentActionChangeOptions(
    current: ImportOptions | undefined | null,
    paymentAction: ImportOptions["paymentAction"] | ""
): Partial<ImportOptions> {
    if (paymentAction === "SKIP_PAYMENTS") return paymentSkipOptions();
    return {
        paymentAction: paymentAction || undefined,
        ...(paymentAction ? { paymentHistoryMode: current?.paymentHistoryMode ?? "START_CURRENT_JOINED_CYCLE" as const } : {}),
        ...(!current?.paymentCycle || current.paymentCycle === "SKIP_PAYMENTS" ? { paymentCycle: "USE_JOINED_AT_ANNIVERSARY" as const } : {}),
    };
}

export function deferAllocationOptions(): Partial<ImportOptions> {
    return {
        skipUnknownSeatAllocations: true,
        skipUnknownShiftAllocations: true,
        skipUnknownMultiShiftAllocations: true,
        skipMissingShiftAllocations: true,
        skipConflictingAllocations: true,
    };
}

export function studentsOnlyImportOptions(): Partial<ImportOptions> {
    return {
        ...deferAllocationOptions(),
        ...paymentSkipOptions(),
    };
}

export function studentOnlyNormalizedData(row: ImportNormalizedRow | null | undefined): ImportNormalizedRow {
    return row?.student ? { student: { ...row.student } } : {};
}

export function isPaymentSkipped(options: ImportOptions | undefined | null) {
    return options?.paymentCycle === "SKIP_PAYMENTS" && options.paymentAction === "SKIP_PAYMENTS";
}

export function isPaymentExplicitlyReady(options: ImportOptions | undefined | null) {
    if (isPaymentSkipped(options)) return true;
    if (!options?.paymentCycle || !options.paymentAction) return false;
    if (options.paymentAction === "IMPORT_PAID_UNPAID") return Boolean(options.paymentMapping?.confirmed);
    return options.paymentAction === "GENERATE_DUE";
}

export function isImportPlanFresh(
    plan: { planVersion?: string; readinessPolicy?: ImportReadinessPolicy; revision?: number } | null | undefined,
    readinessPolicy: ImportReadinessPolicy,
    revision?: number
) {
    return Boolean(
        plan?.planVersion &&
        plan.readinessPolicy === readinessPolicy &&
        (revision === undefined || plan.revision === revision)
    );
}

export function aiAssistanceState(input: {
    ai?: ImportAITrace;
    usedFallback?: boolean;
    mappingNeedsReview?: boolean;
}) {
    const status = input.ai?.status;
    const fallbackReason = input.ai?.fallbackReason ?? input.ai?.error;
    if (!status && !input.usedFallback) {
        return {
            tone: "cyan" as const,
            title: "Manual review ready",
            message: "Column meanings can be reviewed manually before any import runs.",
            needsMappingReview: Boolean(input.mappingNeedsReview),
        };
    }

    if (status === "success" && !input.usedFallback) {
        return {
            tone: input.mappingNeedsReview ? "warning" as const : "success" as const,
            title: input.mappingNeedsReview ? "AI suggestions need review" : "AI suggestions available",
            message: input.mappingNeedsReview
                ? "Some suggested column meanings were left for manual confirmation."
                : "AI suggested column meanings, and deterministic checks will still decide what is importable.",
            needsMappingReview: Boolean(input.mappingNeedsReview),
        };
    }

    return {
        tone: "warning" as const,
        title: "AI unavailable, import can continue",
        message: fallbackReason
            ? `${fallbackReason} Deterministic matching is in use.`
            : "Deterministic matching is in use, and manual review remains available.",
        // AI availability is advisory. Once every suggestion has been explicitly
        // reviewed, including columns intentionally mapped to "ignore", the
        // mapping step is complete even if the original suggestion used fallback.
        needsMappingReview: input.mappingNeedsReview ?? true,
    };
}

function readyRowCount(summary: ImportWizardDetailLike["summary"]) {
    return (summary?.readyRows ?? 0) + (summary?.warningRows ?? 0);
}

function attentionRowCount(summary: ImportWizardDetailLike["summary"]) {
    return (
        (summary?.needsReviewRows ?? 0) +
        (summary?.blockedRows ?? 0) +
        (summary?.duplicateRows ?? 0) +
        (summary?.conflictRows ?? 0)
    );
}

function detectedPaymentCount(detail: ImportWizardDetailLike) {
    return (
        detail.mapping?.analysis?.detectedPaymentValues?.length ??
        detail.summary?.detectedEntityCounts?.PAYMENT ??
        0
    );
}

export function buildImportWizardSteps(input: {
    detail: ImportWizardDetailLike | null;
    plan?: { canRun: boolean; readinessPolicy: ImportReadinessPolicy; planVersion: string; revision?: number } | null;
    readinessPolicy: ImportReadinessPolicy;
}): ImportWizardStep[] {
    const detail = input.detail;
    const mapping = detail?.mapping?.columnMappings ?? [];
    const mappingNeedsReview = mapping.some(item => item.needsReview === true);
    const aiState = aiAssistanceState({
        ai: detail?.mapping?.analysis?.ai,
        usedFallback: detail?.mapping?.usedFallback,
        mappingNeedsReview,
    });
    const openQuestions = detail?.questions?.filter(question => question.status === "OPEN").length ?? 0;
    const readyRows = readyRowCount(detail?.summary);
    const attentionRows = attentionRowCount(detail?.summary);
    const paymentCount = detail ? detectedPaymentCount(detail) : 0;
    const paymentReady = paymentCount === 0 || isPaymentExplicitlyReady(detail?.mapping?.importOptions);
    const planFresh = isImportPlanFresh(input.plan, input.readinessPolicy);
    const hasCommit = Boolean(detail?.commits?.length || ["COMMITTED", "PARTIAL"].includes(detail?.status ?? ""));

    return [
        {
            id: "columns",
            label: "Columns",
            state: mapping.length === 0 || aiState.needsMappingReview ? "needs_attention" : "completed",
            count: mapping.length,
            detail: mapping.length === 0 ? "Map source columns" : aiState.title,
        },
        {
            id: "decisions",
            label: "Decisions",
            state: openQuestions > 0 ? "needs_attention" : "completed",
            count: openQuestions,
            detail: openQuestions > 0 ? `${openQuestions} open` : "No open decisions",
        },
        {
            id: "rows",
            label: "Rows",
            state: readyRows > 0 && attentionRows === 0 ? "completed" : attentionRows > 0 ? "needs_attention" : "pending",
            count: attentionRows || readyRows,
            detail: attentionRows > 0 ? `${attentionRows} row${attentionRows === 1 ? "" : "s"} need attention` : `${readyRows} ready`,
        },
        {
            id: "payments",
            label: "Payments",
            state: paymentReady ? "completed" : "needs_attention",
            count: paymentCount,
            detail: paymentReady ? (isPaymentSkipped(detail?.mapping?.importOptions) ? "Skipped for now" : "Payment plan ready") : "Choose or skip payment import",
        },
        {
            id: "preview",
            label: "Preview",
            state: input.plan?.canRun && planFresh ? "completed" : "pending",
            detail: planFresh ? "Reviewed plan is fresh" : "Refresh final plan",
        },
        {
            id: "result",
            label: "Result",
            state: hasCommit ? "completed" : "pending",
            detail: hasCommit ? "Import report ready" : "No commit yet",
        },
    ];
}
