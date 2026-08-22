import type { ImportColumnMapping, ImportTargetField } from "@/importing/contracts/import-session.contract";

const VARIANT_MAP: Array<{ target: ImportTargetField; patterns: RegExp[]; reason: string }> = [
    { target: "student.name", patterns: [/^name$/, /student.*name/, /candidate/, /member/], reason: "Looks like the student name column." },
    { target: "student.phone", patterns: [/mobile/, /phone/, /contact/, /whatsapp/], reason: "Looks like a phone or mobile column." },
    { target: "student.joinedAt", patterns: [/join/, /admission/, /student.*start.*date/, /member.*since/, /^date$/], reason: "Looks like a joining or admission date." },
    { target: "student.monthlyFee", patterns: [/monthly.*fee/, /^fee$/, /rent/, /amount/], reason: "Looks like a monthly fee amount." },
    { target: "seat.label", patterns: [/seat.*no/, /seat.*number/, /^seat$/, /desk/, /table/], reason: "Looks like a seat label." },
    { target: "allocation.seatLabel", patterns: [/allocated.*seat/, /seat.*label/, /seat.*no/, /^seat$/], reason: "Looks like the allocation seat." },
    { target: "shift.name", patterns: [/^shift$/, /batch/, /slot/, /timing/, /time$/], reason: "Looks like a shift or batch name." },
    { target: "allocation.shiftName", patterns: [/allocated.*shift/, /^shift$/, /batch/, /slot/], reason: "Looks like the allocation shift." },
    { target: "shift.startTime", patterns: [/start.*time/, /from/], reason: "Looks like shift start time." },
    { target: "shift.endTime", patterns: [/end.*time/, /to/], reason: "Looks like shift end time." },
    { target: "multiShift.name", patterns: [/multi.*shift/, /combo/, /package/], reason: "Looks like a multi-shift bundle." },
    { target: "multiShift.componentShiftNames", patterns: [/component.*shift/, /included.*shift/], reason: "Looks like component shifts." },
    { target: "payment.amount", patterns: [/paid.*amount/, /payment.*amount/, /received/, /amount/], reason: "Looks like a payment amount." },
    { target: "payment.status", patterns: [/paid/, /unpaid/, /payment.*status/, /due/, /clear/], reason: "Looks like paid/unpaid status." },
    { target: "payment.method", patterns: [/method/, /mode/, /cash/, /upi/, /bank/], reason: "Looks like payment method." },
    { target: "payment.referenceId", patterns: [/reference/, /ref/, /txn/, /transaction/], reason: "Looks like payment reference." },
];

export function normalizeColumnName(value: string) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ");
}

export function suggestMappingForColumn(column: string): ImportColumnMapping {
    const normalized = normalizeColumnName(column);
    const match = VARIANT_MAP.find(item => item.patterns.some(pattern => pattern.test(normalized)));

    if (!match) {
        return {
            sourceColumn: column,
            targetField: "ignore",
            confidence: 35,
            reason: "No safe deterministic match.",
            source: "DETERMINISTIC",
            autoApplied: false,
            needsReview: true,
        };
    }

    return {
        sourceColumn: column,
        targetField: match.target,
        confidence: 82,
        reason: match.reason,
        source: "DETERMINISTIC",
        autoApplied: true,
        needsReview: false,
    };
}

export function buildFallbackMappings(columns: string[]): ImportColumnMapping[] {
    const seenTargets = new Set<ImportTargetField>();

    return columns.map(column => {
        const mapping = suggestMappingForColumn(column);
        if (mapping.targetField !== "ignore" && seenTargets.has(mapping.targetField)) {
            return {
                ...mapping,
                targetField: "ignore",
                confidence: 40,
                reason: "Another column already maps to this field.",
                source: "DETERMINISTIC",
                autoApplied: false,
                needsReview: true,
            };
        }
        seenTargets.add(mapping.targetField);
        return mapping;
    });
}
