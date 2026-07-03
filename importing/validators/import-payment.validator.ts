import type { ImportMappingState, ImportNormalizedRow } from "@/importing/contracts/import-session.contract";
import { emptyValidatorResult, type ImportValidatorResult } from "./import-required-fields.validator";

export function validateImportPayment(
    normalized: ImportNormalizedRow,
    mapping: ImportMappingState
): ImportValidatorResult {
    const result = emptyValidatorResult();
    const payment = normalized.payment;
    const options = mapping.importOptions;
    const mappedPaymentColumn = mapping.columnMappings.some(mapping => mapping.targetField.startsWith("payment."));
    const hasPaymentData = Boolean(payment?.amount || payment?.rawStatus || payment?.status || payment?.period);
    const intendsPayments = Boolean(
        hasPaymentData ||
        mappedPaymentColumn ||
        mapping.entityTypesDetected.includes("PAYMENT") ||
        (options?.paymentAction && options.paymentAction !== "SKIP_PAYMENTS") ||
        (options?.paymentCycle && options.paymentCycle !== "SKIP_PAYMENTS")
    );

    if (!intendsPayments) return result;

    if (!options?.paymentCycle) {
        result.warnings.push({
            code: "PAYMENT_CYCLE_REQUIRED",
            field: "payment.period",
            message: "Payment cycle must be confirmed before payment data can be imported.",
            severity: "warning",
        });
        result.questions.push({
            field: "payment.period",
            question: "Should payments use each student's joined-date cycle?",
            options: ["USE_JOINED_AT_ANNIVERSARY", "SKIP_PAYMENTS"],
        });
    }

    if (options?.paymentCycle === "SKIP_PAYMENTS" && options.paymentAction && options.paymentAction !== "SKIP_PAYMENTS") {
        result.warnings.push({
            code: "PAYMENT_CYCLE_ACTION_MISMATCH",
            field: "payment.period",
            message: "Payment action is enabled, but the payment cycle is set to skip payments.",
            severity: "warning",
        });
    }

    if (options?.paymentCycle === "CUSTOM_PERIOD") {
        const start = options.customPeriodStart ? new Date(options.customPeriodStart) : null;
        const end = options.customPeriodEnd ? new Date(options.customPeriodEnd) : null;
        const invalidRange = !start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end;
        if (invalidRange) {
            result.warnings.push({
                code: "PAYMENT_CUSTOM_PERIOD_REQUIRED",
                field: "payment.customPeriod",
                message: "Choose a valid custom payment period start and end date.",
                severity: "warning",
            });
        }
    }

    if (
        options?.paymentCycle === "USE_JOINED_AT_ANNIVERSARY" &&
        normalized.student?.joinedAtSource === "TODAY_DEFAULT"
    ) {
        result.warnings.push({
            code: "PAYMENT_JOINED_AT_REQUIRED",
            field: "student.joinedAt",
            message: "Payment cycle uses each student's joined date, but this row is using today's fallback date.",
            severity: "warning",
        });
    }

    if (!options?.paymentAction) {
        result.warnings.push({
            code: "PAYMENT_ACTION_REQUIRED",
            field: "payment.status",
            message: "Choose whether to generate dues, import paid/unpaid status, or skip payments.",
            severity: "warning",
        });
        result.questions.push({
            field: "payment.status",
            question: "What should happen after student import?",
            options: ["GENERATE_DUE", "IMPORT_PAID_UNPAID", "SKIP_PAYMENTS"],
        });
    }

    if (options?.paymentAction === "IMPORT_PAID_UNPAID" && !options.paymentMapping?.confirmed) {
        result.warnings.push({
            code: "PAYMENT_STATUS_MAPPING_UNCONFIRMED",
            field: "payment.status",
            message: "Paid/unpaid mapping must be confirmed before importing payment status.",
            severity: "warning",
        });
    }

    if (options?.paymentAction === "IMPORT_PAID_UNPAID" && payment?.status === "UNCLEAR") {
        result.warnings.push({
            code: "AMBIGUOUS_PAYMENT_STATUS",
            field: "payment.status",
            message: `Payment value "${payment?.rawStatus ?? ""}" is unclear.`,
            severity: "warning",
        });
    }

    return result;
}
