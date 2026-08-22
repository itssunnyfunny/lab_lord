import {
    IMPORT_TARGET_FIELDS,
    type ImportColumnMapping,
    type ImportOptions,
} from "@/importing/contracts/import-session.contract";
import { ImportRequestError } from "./import-request";

const TARGET_FIELDS = new Set<string>(IMPORT_TARGET_FIELDS);
const PAYMENT_CYCLES = new Set(["USE_JOINED_AT_ANNIVERSARY", "SKIP_PAYMENTS"]);
const PAYMENT_ACTIONS = new Set(["GENERATE_DUE", "IMPORT_PAID_UNPAID", "SKIP_PAYMENTS"]);
const PAYMENT_HISTORY_MODES = new Set([
    "START_CURRENT_JOINED_CYCLE",
    "FROM_JOINED_MARK_PAID",
    "FROM_JOINED_MARK_DUE",
    "FROM_JOINED_PAID_THROUGH_PREVIOUS",
]);
const PAYMENT_METHODS = new Set(["CASH", "UPI", "BANK_TRANSFER"]);
const BOOLEAN_OPTION_KEYS = [
    "createUnknownSeats",
    "createUnknownShifts",
    "createUnknownMultiShifts",
    "configurationBatchApproved",
    "skipUnknownSeatAllocations",
    "skipUnknownShiftAllocations",
    "skipUnknownMultiShiftAllocations",
    "skipMissingShiftAllocations",
    "skipConflictingAllocations",
] as const;
const STRING_OPTION_KEYS = [
    "defaultJoinedAt",
    "defaultSeatLabel",
    "defaultShiftName",
    "defaultMultiShiftName",
] as const;
const ALLOWED_OPTION_KEYS = new Set<string>([
    "paymentCycle",
    "paymentAction",
    "paymentHistoryMode",
    "paymentMapping",
    ...BOOLEAN_OPTION_KEYS,
    ...STRING_OPTION_KEYS,
]);
const ALLOWED_PAYMENT_MAPPING_KEYS = new Set([
    "paidValues",
    "unpaidValues",
    "waivedValues",
    "unclearValues",
    "confirmed",
    "defaultMethod",
]);

function invalid(message: string): never {
    throw new ImportRequestError(message, { code: "INVALID_IMPORT_MAPPING" });
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        invalid(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maxLength: number) {
    if (typeof value !== "string") invalid(`${label} must be text.`);
    const normalized = value.normalize("NFKC").trim();
    if (normalized.length > maxLength) invalid(`${label} is too long.`);
    return normalized;
}

function stringValues(value: unknown, label: string) {
    if (!Array.isArray(value) || value.length > 100) {
        invalid(`${label} must contain at most 100 text values.`);
    }
    return [...new Set(value.map((item, index) => {
        if (typeof item !== "string") invalid(`${label} value ${index + 1} must be text.`);
        const text = item.trim();
        if (text.length > 128) invalid(`${label} value ${index + 1} is too long.`);
        return text;
    }).filter(Boolean))];
}

function parseColumnMappings(value: unknown): ImportColumnMapping[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
        invalid("Column mappings must contain between 1 and 64 columns.");
    }

    const sourceColumns = new Set<string>();
    const targetFields = new Set<string>();
    return value.map((candidate, index) => {
        const item = record(candidate, `Column mapping ${index + 1}`);
        if (typeof item.sourceColumn !== "string") {
            invalid(`Column mapping ${index + 1} source must be text.`);
        }
        // Preserve the parser's exact positional key. Compatibility
        // normalization (for example full-width to ASCII) would make a
        // reviewed header no longer match its persisted raw-row property.
        const sourceColumn = item.sourceColumn.trim();
        if (sourceColumn.length > 8 * 1024) invalid(`Column mapping ${index + 1} source is too long.`);
        if (!sourceColumn || sourceColumns.has(sourceColumn)) {
            invalid("Every source column must be mapped exactly once.");
        }
        sourceColumns.add(sourceColumn);

        if (typeof item.targetField !== "string" || !TARGET_FIELDS.has(item.targetField)) {
            invalid(`Column mapping ${index + 1} has an unsupported target field.`);
        }
        if (item.targetField !== "ignore" && targetFields.has(item.targetField)) {
            invalid(`Only one source column can map to ${item.targetField}.`);
        }
        if (item.targetField !== "ignore") targetFields.add(item.targetField);

        if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
            || item.confidence < 0 || item.confidence > 100) {
            invalid(`Column mapping ${index + 1} confidence must be between 0 and 100.`);
        }
        const reason = item.reason === undefined
            ? undefined
            : boundedString(item.reason, `Column mapping ${index + 1} reason`, 500);

        return {
            sourceColumn,
            targetField: item.targetField as ImportColumnMapping["targetField"],
            confidence: item.confidence,
            ...(reason ? { reason } : {}),
            source: "MANUAL" as const,
            autoApplied: false,
            needsReview: false,
        };
    });
}

function parsePaymentMapping(value: unknown): ImportOptions["paymentMapping"] {
    const input = record(value, "Payment mapping");
    for (const key of Object.keys(input)) {
        if (!ALLOWED_PAYMENT_MAPPING_KEYS.has(key)) invalid(`Payment mapping option ${key} is not supported.`);
    }
    const confirmed = input.confirmed;
    if (confirmed !== undefined && typeof confirmed !== "boolean") {
        invalid("Payment mapping confirmation must be true or false.");
    }
    const defaultMethod = input.defaultMethod;
    if (defaultMethod !== undefined && (typeof defaultMethod !== "string" || !PAYMENT_METHODS.has(defaultMethod))) {
        invalid("Payment mapping default method is not supported.");
    }
    return {
        paidValues: input.paidValues === undefined ? [] : stringValues(input.paidValues, "Paid values"),
        unpaidValues: input.unpaidValues === undefined ? [] : stringValues(input.unpaidValues, "Unpaid values"),
        waivedValues: input.waivedValues === undefined ? [] : stringValues(input.waivedValues, "Waived values"),
        unclearValues: input.unclearValues === undefined ? [] : stringValues(input.unclearValues, "Unclear values"),
        confirmed: confirmed ?? false,
        ...(defaultMethod ? { defaultMethod: defaultMethod as NonNullable<ImportOptions["paymentMapping"]>["defaultMethod"] } : {}),
    };
}

function parseImportOptions(value: unknown): Partial<ImportOptions> | undefined {
    if (value === undefined) return undefined;
    const input = record(value, "Import options");
    for (const key of Object.keys(input)) {
        if (!ALLOWED_OPTION_KEYS.has(key)) invalid(`Import option ${key} is not supported.`);
    }

    const result: Partial<ImportOptions> = {};
    if (input.paymentCycle !== undefined) {
        if (typeof input.paymentCycle !== "string" || !PAYMENT_CYCLES.has(input.paymentCycle)) {
            invalid("Payment cycle option is not supported.");
        }
        result.paymentCycle = input.paymentCycle as ImportOptions["paymentCycle"];
    }
    if (input.paymentAction !== undefined) {
        if (typeof input.paymentAction !== "string" || !PAYMENT_ACTIONS.has(input.paymentAction)) {
            invalid("Payment action is not supported.");
        }
        result.paymentAction = input.paymentAction as ImportOptions["paymentAction"];
    }
    if (input.paymentHistoryMode !== undefined) {
        if (typeof input.paymentHistoryMode !== "string" || !PAYMENT_HISTORY_MODES.has(input.paymentHistoryMode)) {
            invalid("Payment history option is not supported.");
        }
        result.paymentHistoryMode = input.paymentHistoryMode as ImportOptions["paymentHistoryMode"];
    }
    if (input.paymentMapping !== undefined) result.paymentMapping = parsePaymentMapping(input.paymentMapping);

    for (const key of BOOLEAN_OPTION_KEYS) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== "boolean") invalid(`Import option ${key} must be true or false.`);
        result[key] = input[key] as boolean;
    }
    for (const key of STRING_OPTION_KEYS) {
        if (input[key] === undefined) continue;
        result[key] = boundedString(input[key], `Import option ${key}`, 160);
    }
    return result;
}

export function parseImportMappingMutation(input: {
    columnMappings?: unknown;
    importOptions?: unknown;
}) {
    return {
        columnMappings: parseColumnMappings(input.columnMappings),
        importOptions: parseImportOptions(input.importOptions),
    };
}
