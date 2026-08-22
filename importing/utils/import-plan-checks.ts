import { createHash } from "crypto";
import type { CommitMode, ImportIssue, ImportMappingState, ImportNormalizedRow } from "@/importing/contracts/import-session.contract";
import type { ImportPlanCheck } from "@/importing/contracts/import-preview.contract";

type PlanRow = {
    id?: string;
    rowId?: string;
    rowNumber?: number;
    status: string;
    skipped?: boolean;
    normalizedData: ImportNormalizedRow | null;
    issues?: unknown;
    warnings?: unknown;
};

type PlanCheckInput = {
    mapping: ImportMappingState;
    rows: PlanRow[];
    hasOpenQuestions: boolean;
    mode?: CommitMode;
};

function issueList(value: unknown): ImportIssue[] {
    return Array.isArray(value) ? value.filter((item): item is ImportIssue =>
        item &&
        typeof item === "object" &&
        "code" in item &&
        "message" in item &&
        "severity" in item
    ) : [];
}

function activeRows(rows: PlanRow[]) {
    return rows.filter(row => !row.skipped && ["READY", "WARNING"].includes(row.status));
}

function blockedRows(rows: PlanRow[]) {
    return rows.filter(row => ["BLOCKED", "CONFLICT", "NEEDS_REVIEW", "DUPLICATE", "FAILED"].includes(row.status));
}

function hasPaymentData(row: PlanRow) {
    const payment = row.normalizedData?.payment;
    return Boolean(payment?.amount || payment?.status || payment?.rawStatus || payment?.method || payment?.referenceId);
}

function skipsAllocation(row: PlanRow) {
    return issueList(row.warnings).some(issue => issue.code.startsWith("ALLOCATION_SKIPPED_"));
}

export function buildImportPlanChecks(input: PlanCheckInput): ImportPlanCheck[] {
    const rows = input.rows;
    const importableRows = activeRows(rows);
    const rowsInCommitScope = input.mode === "SAFE_PARTIAL" ? importableRows : rows.filter(row => !row.skipped);
    const blocked = blockedRows(rows);
    const options = input.mapping.importOptions ?? {};
    const action = options.paymentAction;
    const cycle = options.paymentCycle;
    const actionEnabled = Boolean(action && action !== "SKIP_PAYMENTS");
    const cycleEnabled = Boolean(cycle && cycle !== "SKIP_PAYMENTS");
    const paymentRowsInScope = rowsInCommitScope.filter(hasPaymentData);
    const paymentDataRows = paymentRowsInScope.length;
    const unclearPaymentRowsInScope = rowsInCommitScope.filter(row => row.normalizedData?.payment?.status === "UNCLEAR").length;
    const deterministicScopedPaymentWords =
        input.mode === "SAFE_PARTIAL" &&
        paymentDataRows > 0 &&
        unclearPaymentRowsInScope === 0;
    const studentRows = importableRows.filter(row => row.normalizedData?.student?.name).length;
    const allocationRows = importableRows.filter(row =>
        !skipsAllocation(row) &&
        row.normalizedData?.allocation?.seatLabel &&
        (row.normalizedData.allocation.shiftName || row.normalizedData.allocation.multiShiftName)
    ).length;
    const incompleteAllocationRows = importableRows.filter(row => {
        const normalized = row.normalizedData;
        return Boolean(
            normalized?.allocation?.seatLabel &&
            !normalized.allocation.shiftName &&
            !normalized.allocation.multiShiftName &&
            !skipsAllocation(row)
        );
    }).length;
    const paymentWarnings = rowsInCommitScope
        .flatMap(row => issueList(row.warnings))
        .filter(issue => issue.code.startsWith("PAYMENT"))
        .filter(issue => !deterministicScopedPaymentWords || issue.code !== "PAYMENT_STATUS_MAPPING_UNCONFIRMED");
    const aiStatus = input.mapping.analysis?.ai?.status;
    const checks: ImportPlanCheck[] = [];

    checks.push({
        code: "READY_ROWS",
        label: "Rows ready",
        status: importableRows.length > 0 ? "pass" : "block",
        count: importableRows.length,
        message: importableRows.length > 0
            ? `${importableRows.length} row${importableRows.length === 1 ? "" : "s"} can be imported.`
            : "No staged rows are ready to import.",
        action: importableRows.length > 0 ? undefined : "Fix blocked rows or change the row filter to find rows that need attention.",
    });

    checks.push({
        code: "OPEN_QUESTIONS",
        label: "Decisions answered",
        status: input.hasOpenQuestions ? "block" : "pass",
        message: input.hasOpenQuestions
            ? "Open import decisions remain."
            : "No open import decisions remain.",
        action: input.hasOpenQuestions ? "Answer the Decisions tab before importing." : undefined,
    });

    checks.push({
        code: "STUDENT_RECORDS",
        label: "Students",
        status: studentRows > 0 ? "pass" : "block",
        count: studentRows,
        message: studentRows > 0
            ? `${studentRows} student record${studentRows === 1 ? "" : "s"} will be created.`
            : "No ready row has a student name.",
        action: studentRows > 0 ? undefined : "Map or edit the student name field.",
    });

    checks.push({
        code: "SEAT_SHIFT_LINKS",
        label: "Seat and shift links",
        status: incompleteAllocationRows > 0 ? "block" : allocationRows > 0 ? "pass" : "warning",
        count: allocationRows,
        message: incompleteAllocationRows > 0
            ? `${incompleteAllocationRows} ready row${incompleteAllocationRows === 1 ? " has" : "s have"} a seat without a shift or bundle.`
            : allocationRows > 0
                ? `${allocationRows} seat/shift link${allocationRows === 1 ? "" : "s"} will be created.`
                : "Students can import, but no seat/shift links are ready.",
        action: incompleteAllocationRows > 0
            ? "Edit those rows or choose to skip missing allocations."
            : allocationRows > 0
                ? undefined
                : "Edit rows if seats and shifts should be linked now.",
    });

    let paymentStatus: ImportPlanCheck["status"] = "pass";
    let paymentMessage = "Payments are skipped for this import.";
    let paymentAction: string | undefined;

    if (paymentDataRows > 0 || actionEnabled || cycleEnabled) {
        if (paymentDataRows > 0 && action === "SKIP_PAYMENTS" && cycle === "SKIP_PAYMENTS") {
            paymentStatus = "pass";
            paymentMessage = "Payment values were detected and are explicitly skipped.";
        } else if (actionEnabled && !cycleEnabled) {
            paymentStatus = "block";
            paymentMessage = "Payment action is enabled, but no payment cycle is selected.";
            paymentAction = "Choose a payment cycle or skip payments.";
        } else if (cycleEnabled && !actionEnabled) {
            paymentStatus = "block";
            paymentMessage = "A payment cycle is selected, but no payment action is selected.";
            paymentAction = "Choose Generate due, Import paid/unpaid, or skip payments.";
        } else if (cycle === "SKIP_PAYMENTS" && actionEnabled) {
            paymentStatus = "block";
            paymentMessage = "Payment action is enabled while the cycle is set to skip payments.";
            paymentAction = "Make payment cycle and action agree.";
        } else if (action === "SKIP_PAYMENTS" && cycleEnabled) {
            paymentStatus = "block";
            paymentMessage = "Payment cycle is enabled while the action is set to skip payments.";
            paymentAction = "Make payment cycle and action agree.";
        } else if (actionEnabled && cycleEnabled) {
            paymentStatus = paymentWarnings.length > 0 ? "warning" : "pass";
            paymentMessage = paymentWarnings.length > 0
                ? paymentWarnings[0].message
                : "Payment cycle and action are ready.";
            paymentAction = paymentWarnings.length > 0 ? "Review the Payments tab before commit." : undefined;
        } else if (paymentDataRows > 0) {
            paymentStatus = "block";
            paymentMessage = "Payment values were detected, but payment cycle/action are not confirmed.";
            paymentAction = "Confirm the Payments tab or choose to skip payments.";
        }
    }

    checks.push({
        code: "PAYMENT_PLAN",
        label: "Payment plan",
        status: paymentStatus,
        count: paymentDataRows,
        message: paymentMessage,
        action: paymentAction,
    });

    if (action === "IMPORT_PAID_UNPAID") {
        checks.push({
            code: "PAYMENT_WORDS",
            label: "Paid/unpaid words",
            status: options.paymentMapping?.confirmed || deterministicScopedPaymentWords ? "pass" : "block",
            message: options.paymentMapping?.confirmed
                ? "Paid, unpaid, and waived values are confirmed."
                : deterministicScopedPaymentWords
                    ? "Ready rows use deterministic payment words. Blocked rows can be resolved later."
                : "Paid/unpaid values need confirmation.",
            action: options.paymentMapping?.confirmed || deterministicScopedPaymentWords ? undefined : "Confirm detected payment values in Payments.",
        });
    }

    checks.push({
        code: "AI_SUGGESTION",
        label: "AI suggestions",
        status: !aiStatus || aiStatus === "success" ? "pass" : "warning",
        message: !aiStatus
            ? "No AI trace is attached; deterministic checks still ran."
            : aiStatus === "success"
                ? "AI mapping returned structured output and deterministic checks ran."
                : `AI mapping used ${aiStatus.replace(/_/g, " ")}; deterministic checks are being used as the source of truth.`,
        action: !aiStatus || aiStatus === "success" ? undefined : "Review column meanings before importing.",
    });

    if (input.mode === "STRICT_ALL_OR_NOTHING") {
        checks.push({
            code: "STRICT_MODE",
            label: "Strict mode",
            status: blocked.length > 0 ? "block" : "pass",
            count: blocked.length,
            message: blocked.length > 0
                ? `${blocked.length} row${blocked.length === 1 ? " is" : "s are"} not clean, so strict import will not run.`
                : "All rows are clean enough for strict import.",
            action: blocked.length > 0 ? "Fix or skip every blocked/review row, or use safe partial import." : undefined,
        });
    }

    return checks;
}

export function getBlockingImportPlanChecks(checks: ImportPlanCheck[]) {
    return checks.filter(check => check.status === "block");
}

export function createImportPlanVersion(input: {
    sessionId: string;
    status: string;
    mapping: ImportMappingState;
    rows: PlanRow[];
}) {
    return createHash("sha256")
        .update(JSON.stringify({
            sessionId: input.sessionId,
            status: input.status,
            importOptions: input.mapping.importOptions ?? {},
            columnMappings: input.mapping.columnMappings,
            rows: input.rows.map(row => ({
                id: row.id ?? row.rowId,
                status: row.status,
                skipped: Boolean(row.skipped),
                normalizedData: row.normalizedData,
                issues: row.issues,
                warnings: row.warnings,
            })),
        }))
        .digest("hex")
        .slice(0, 12);
}
