import type { ImportNormalizedRow } from "@/importing/contracts/import-session.contract";
import { validateSeatLabel } from "@/lib/formValidation";
import { emptyValidatorResult, type ImportValidatorResult } from "./import-required-fields.validator";

export function validateImportSeat(
    normalized: ImportNormalizedRow,
    context: {
        seatsByLabel: Map<string, { id: string; label: string }>;
        createUnknownSeats?: boolean;
        skipUnknownSeatAllocations?: boolean;
    }
): ImportValidatorResult {
    const result = emptyValidatorResult();
    let label = normalized.allocation?.seatLabel ?? normalized.seat?.label;
    if (!label) return result;

    let known = context.seatsByLabel.has(label.toLowerCase());
    if (!known && context.createUnknownSeats) {
        const labelResult = validateSeatLabel(label);
        if (!labelResult.ok) {
            result.issues.push({
                code: "INVALID_SEAT_LABEL",
                field: "seat.label",
                message: labelResult.error,
                severity: "error",
            });
            return result;
        }
        label = labelResult.value;
        normalized.seat = { ...normalized.seat, label };
        normalized.allocation = { ...normalized.allocation, seatLabel: label };
        known = context.seatsByLabel.has(label.toLowerCase());
    }

    if (!known && context.skipUnknownSeatAllocations) {
        result.warnings.push({
            code: "ALLOCATION_SKIPPED_UNKNOWN_SEAT",
            field: "allocation.seatLabel",
            message: `Student will import without allocation because seat "${label}" is not in this branch.`,
            severity: "info",
        });
    }

    if (!known && !context.createUnknownSeats && !context.skipUnknownSeatAllocations) {
        result.warnings.push({
            code: "UNKNOWN_SEAT",
            field: "allocation.seatLabel",
            message: `Seat "${label}" does not exist yet. Confirm whether to create it.`,
            severity: "warning",
        });
        result.questions.push({
            field: "seat.label",
            question: `Create missing seat "${label}" during import?`,
            options: ["YES_CREATE_SEATS", "SKIP_UNKNOWN_SEAT_ALLOCATION"],
        });
    }

    if (!known && context.createUnknownSeats) {
        result.warnings.push({
            code: "WILL_CREATE_SEAT",
            field: "seat.label",
            message: `Seat "${label}" will be created before allocation.`,
            severity: "warning",
        });
    }

    return result;
}
