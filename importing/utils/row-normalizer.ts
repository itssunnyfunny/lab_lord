import type {
    ImportColumnMapping,
    ImportIssue,
    ImportBranchContext,
    ImportNormalizedRow,
    ImportOptions,
    ParsedImportRow,
} from "@/importing/contracts/import-session.contract";
import type { PaymentMethod, PaymentStatus } from "@/app/generated/prisma/enums";
import { validatePhone } from "@/lib/formValidation";

export function compactImportText(value: unknown) {
    return value == null ? "" : String(value).trim().replace(/\s+/g, " ");
}

export function normalizeNameKey(value: unknown) {
    return compactImportText(value).toLocaleLowerCase("en-IN");
}

export function normalizePhoneKey(value: unknown) {
    const validated = validatePhone(value);
    return validated.ok && validated.value
        ? validated.value.replace(/\D/g, "")
        : "";
}

export function parseImportMoney(value: unknown): number | undefined {
    const text = compactImportText(value)
        .replace(/^(?:₹|rs\.?|inr)\s*/i, "")
        .replace(/,/g, "")
        .trim();
    if (!/^\d+(?:\.0+)?$/.test(text)) return undefined;
    const normalized = Number(text);
    return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : undefined;
}

export function parseImportDate(value: unknown): string | undefined {
    const text = compactImportText(value);
    if (!text) return undefined;

    const indian = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
    if (indian) {
        const day = Number(indian[1]);
        const month = Number(indian[2]);
        const year = Number(indian[3].length === 2 ? `20${indian[3]}` : indian[3]);
        const parsed = new Date(Date.UTC(year, month - 1, day));
        if (
            parsed.getUTCFullYear() !== year
            || parsed.getUTCMonth() !== month - 1
            || parsed.getUTCDate() !== day
        ) return undefined;
        return parsed.toISOString();
    }

    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!iso) return undefined;
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
        parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() !== month - 1
        || parsed.getUTCDate() !== day
    ) return undefined;
    return parsed.toISOString();
}

export function parsePaymentMethod(value: unknown): PaymentMethod | undefined {
    const text = compactImportText(value).toLowerCase();
    if (!text) return undefined;
    if (text.includes("upi") || text.includes("gpay") || text.includes("phonepe") || text.includes("paytm")) return "UPI";
    if (text.includes("bank") || text.includes("neft") || text.includes("imps") || text.includes("transfer")) return "BANK_TRANSFER";
    if (text.includes("cash")) return "CASH";
    return undefined;
}

export function classifyPaymentStatus(
    value: unknown,
    mapping?: { paidValues: string[]; unpaidValues: string[]; waivedValues: string[]; confirmed?: boolean }
): PaymentStatus | "UNCLEAR" | undefined {
    const raw = compactImportText(value);
    if (!raw) return undefined;
    const text = raw.toLowerCase();
    const contains = (values: string[]) => values.map(v => v.toLowerCase()).includes(text);

    if (mapping?.confirmed) {
        if (contains(mapping.paidValues)) return "PAID";
        if (contains(mapping.unpaidValues)) return "DUE";
        if (contains(mapping.waivedValues)) return "WAIVED";
        return "UNCLEAR";
    }

    if (["paid", "yes", "y", "done", "clear", "cleared", "received"].includes(text)) return "PAID";
    if (["unpaid", "no", "n", "due", "pending", "not paid"].includes(text)) return "DUE";
    if (["waived", "free", "skip"].includes(text)) return "WAIVED";
    return "UNCLEAR";
}

function setNestedValue(row: ImportNormalizedRow, target: string, value: string, issues: ImportIssue[]) {
    if (!value) return;

    switch (target) {
        case "student.name":
            row.student = { ...row.student, name: value };
            break;
        case "student.phone":
            row.student = { ...row.student, phone: value };
            break;
        case "student.joinedAt":
            {
                const joinedAt = parseImportDate(value);
                if (joinedAt) row.student = { ...row.student, joinedAt, joinedAtSource: "UPLOADED" };
                else issues.push({
                    code: "INVALID_JOINED_DATE",
                    field: target,
                    message: "Joined date must use DD/MM/YYYY or YYYY-MM-DD.",
                    severity: "error",
                });
            }
            break;
        case "student.monthlyFee": {
            const amount = parseImportMoney(value);
            if (amount !== undefined) row.student = { ...row.student, monthlyFee: amount, feeSource: "UPLOADED" };
            else issues.push({ code: "INVALID_MONTHLY_FEE", field: target, message: "Monthly fee is not a whole number.", severity: "error" });
            break;
        }
        case "student.feeSource":
            row.student = { ...row.student, feeSource: "UPLOADED" };
            break;
        case "student.feeLinkedShiftName":
            row.student = { ...row.student, feeLinkedShiftName: value };
            break;
        case "student.feeLinkedMultiShiftName":
            row.student = { ...row.student, feeLinkedMultiShiftName: value };
            break;
        case "seat.label":
        case "allocation.seatLabel":
            row.seat = { ...row.seat, label: value };
            row.allocation = { ...row.allocation, seatLabel: value };
            break;
        case "shift.name":
        case "allocation.shiftName":
            row.shift = { ...row.shift, name: value };
            row.allocation = { ...row.allocation, shiftName: value };
            break;
        case "shift.startTime":
            row.shift = { ...row.shift, startTime: value };
            break;
        case "shift.endTime":
            row.shift = { ...row.shift, endTime: value };
            break;
        case "multiShift.name":
        case "allocation.multiShiftName":
            row.multiShift = { ...row.multiShift, name: value };
            row.allocation = { ...row.allocation, multiShiftName: value };
            break;
        case "multiShift.componentShiftNames":
            row.multiShift = {
                ...row.multiShift,
                componentShiftNames: value.split(/[,+|]/).map(part => compactImportText(part)).filter(Boolean),
            };
            break;
        case "payment.amount": {
            const amount = parseImportMoney(value);
            if (amount !== undefined) row.payment = { ...row.payment, amount };
            else issues.push({ code: "INVALID_PAYMENT_AMOUNT", field: target, message: "Payment amount is not a whole number.", severity: "error" });
            break;
        }
        case "payment.method":
            row.payment = { ...row.payment, method: parsePaymentMethod(value) };
            break;
        case "payment.referenceId":
            row.payment = { ...row.payment, referenceId: value };
            break;
        default:
            break;
    }
}

export function normalizeImportRow(
    rawData: ParsedImportRow,
    mappings: ImportColumnMapping[],
    paymentMapping?: { paidValues: string[]; unpaidValues: string[]; waivedValues: string[]; confirmed?: boolean }
) {
    const normalized: ImportNormalizedRow = {};
    const mappedData: Record<string, string> = {};
    const issues: ImportIssue[] = [];
    let confidenceTotal = 0;
    let confidenceCount = 0;

    for (const mapping of mappings) {
        if (mapping.targetField === "ignore") continue;
        const value = compactImportText(rawData[mapping.sourceColumn]);
        if (!value) continue;
        mappedData[mapping.targetField] = value;
        confidenceTotal += mapping.confidence;
        confidenceCount++;

        if (mapping.targetField === "payment.status") {
            normalized.payment = {
                ...normalized.payment,
                rawStatus: value,
                status: classifyPaymentStatus(value, paymentMapping),
            };
            continue;
        }

        setNestedValue(normalized, mapping.targetField, value, issues);
    }

    return {
        mappedData,
        normalizedData: normalized,
        issues,
        confidence: confidenceCount > 0 ? Math.round(confidenceTotal / confidenceCount) : null,
    };
}

type FeeDefaultContext = Partial<Pick<ImportBranchContext, "defaultFee">> & {
    branchDefaultFee?: number;
    shiftsByName?: Map<string, { name: string; price: number }>;
    multiShiftsByName?: Map<string, { name: string; price: number }>;
};

function applyFeeDefault(normalized: ImportNormalizedRow, context: FeeDefaultContext) {
    const student = normalized.student;
    if (!student || student.monthlyFee !== undefined) return;

    const multiShiftName = student.feeLinkedMultiShiftName ?? normalized.allocation?.multiShiftName ?? normalized.multiShift?.name;
    if (multiShiftName) {
        const multiShift = context.multiShiftsByName?.get(multiShiftName.toLowerCase());
        if (multiShift) {
            normalized.student = {
                ...student,
                monthlyFee: multiShift.price,
                feeSource: "MULTI_SHIFT_PRICE",
                feeLinkedMultiShiftName: multiShift.name,
                feeLinkedShiftName: undefined,
            };
            return;
        }
    }

    const shiftName = student.feeLinkedShiftName ?? normalized.allocation?.shiftName ?? normalized.shift?.name;
    if (shiftName) {
        const shift = context.shiftsByName?.get(shiftName.toLowerCase());
        if (shift) {
            normalized.student = {
                ...student,
                monthlyFee: shift.price,
                feeSource: "SHIFT_PRICE",
                feeLinkedShiftName: shift.name,
                feeLinkedMultiShiftName: undefined,
            };
            return;
        }
    }

    normalized.student = {
        ...student,
        monthlyFee: context.defaultFee ?? context.branchDefaultFee ?? 0,
        feeSource: "BRANCH_DEFAULT",
    };
}

export function applyImportDefaults(normalized: ImportNormalizedRow, options?: ImportOptions, context?: FeeDefaultContext) {
    if (!options && !context) return normalized;

    if (normalized.student && !normalized.student.joinedAt && options?.defaultJoinedAt) {
        normalized.student = {
            ...normalized.student,
            joinedAt: parseImportDate(options.defaultJoinedAt) ?? options.defaultJoinedAt,
            joinedAtSource: "OPERATOR_DEFAULT",
        };
    }

    const hasSeat = Boolean(normalized.allocation?.seatLabel ?? normalized.seat?.label);
    if (!hasSeat && options?.defaultSeatLabel) {
        normalized.seat = { ...normalized.seat, label: options.defaultSeatLabel };
        normalized.allocation = { ...normalized.allocation, seatLabel: options.defaultSeatLabel };
    }

    const hasAllocationSeat = Boolean(normalized.allocation?.seatLabel ?? normalized.seat?.label);
    const hasShift = Boolean(normalized.allocation?.shiftName ?? normalized.shift?.name);
    const hasMultiShift = Boolean(normalized.allocation?.multiShiftName ?? normalized.multiShift?.name);

    if (hasAllocationSeat && !hasShift && !hasMultiShift && options?.defaultShiftName) {
        normalized.shift = { ...normalized.shift, name: options.defaultShiftName };
        normalized.allocation = { ...normalized.allocation, shiftName: options.defaultShiftName };
    }

    if (hasAllocationSeat && !hasShift && !hasMultiShift && options?.defaultMultiShiftName) {
        normalized.multiShift = { ...normalized.multiShift, name: options.defaultMultiShiftName };
        normalized.allocation = { ...normalized.allocation, multiShiftName: options.defaultMultiShiftName };
    }

    if (context) applyFeeDefault(normalized, context);

    return normalized;
}
