import type { ImportNormalizedRow } from "@/importing/contracts/import-session.contract";
import { validateOptionalTime, validateRequiredText } from "@/lib/formValidation";
import { emptyValidatorResult, type ImportValidatorResult } from "./import-required-fields.validator";

export function validateImportShift(
    normalized: ImportNormalizedRow,
    context: {
        shiftsByName: Map<string, { id: string; name: string }>;
        multiShiftsByName: Map<string, { id: string; name: string }>;
        createUnknownShifts?: boolean;
        createUnknownMultiShifts?: boolean;
        skipUnknownShiftAllocations?: boolean;
        skipUnknownMultiShiftAllocations?: boolean;
        skipMissingShiftAllocations?: boolean;
    }
): ImportValidatorResult {
    const result = emptyValidatorResult();
    let shiftName = normalized.allocation?.shiftName ?? normalized.shift?.name;
    let multiShiftName = normalized.allocation?.multiShiftName ?? normalized.multiShift?.name;
    const hasSeat = Boolean(normalized.allocation?.seatLabel ?? normalized.seat?.label);
    const startTime = validateOptionalTime(normalized.shift?.startTime, "Shift start time");
    const endTime = validateOptionalTime(normalized.shift?.endTime, "Shift end time");
    if (!startTime.ok) {
        result.issues.push({
            code: "INVALID_SHIFT_START_TIME",
            field: "shift.startTime",
            message: startTime.error,
            severity: "error",
        });
    }
    if (!endTime.ok) {
        result.issues.push({
            code: "INVALID_SHIFT_END_TIME",
            field: "shift.endTime",
            message: endTime.error,
            severity: "error",
        });
    }
    if (
        startTime.ok
        && endTime.ok
        && ((startTime.value && !endTime.value) || (!startTime.value && endTime.value))
    ) {
        result.issues.push({
            code: "INCOMPLETE_SHIFT_TIME_RANGE",
            field: startTime.value ? "shift.endTime" : "shift.startTime",
            message: "Shift must have both start and end time, or neither.",
            severity: "error",
        });
    }

    if (hasSeat && !shiftName && !multiShiftName && context.skipMissingShiftAllocations) {
        result.warnings.push({
            code: "ALLOCATION_SKIPPED_MISSING_SHIFT",
            field: "allocation.shiftName",
            message: "Student will import without allocation because no shift was provided.",
            severity: "info",
        });
    }

    if (hasSeat && !shiftName && !multiShiftName && !context.skipMissingShiftAllocations) {
        result.warnings.push({
            code: "MISSING_ALLOCATION_SHIFT",
            field: "allocation.shiftName",
            message: "Seat is present but shift is missing. The student can import, but allocation needs review.",
            severity: "warning",
        });
        result.questions.push({
            field: "allocation.shiftName",
            question: "Which shift should rows without a shift use?",
            options: [...Array.from(context.shiftsByName.values()).map(shift => shift.name), "SKIP_MISSING_SHIFT_ALLOCATION"],
        });
    }

    if (shiftName && !context.shiftsByName.has(shiftName.toLowerCase())) {
        if (context.createUnknownShifts) {
            const nameResult = validateRequiredText(shiftName, "Shift name", 50);
            if (!nameResult.ok) {
                result.issues.push({
                    code: "INVALID_SHIFT_NAME",
                    field: "shift.name",
                    message: nameResult.error,
                    severity: "error",
                });
            } else {
                shiftName = nameResult.value;
                normalized.shift = { ...normalized.shift, name: shiftName };
                normalized.allocation = { ...normalized.allocation, shiftName };
                if (!context.shiftsByName.has(shiftName.toLowerCase())) {
                    result.warnings.push({
                        code: "WILL_CREATE_SHIFT",
                        field: "shift.name",
                        message: `Shift "${shiftName}" will be created without times unless corrected.`,
                        severity: "warning",
                    });
                }
            }
        } else if (context.skipUnknownShiftAllocations) {
            result.warnings.push({
                code: "ALLOCATION_SKIPPED_UNKNOWN_SHIFT",
                field: "allocation.shiftName",
                message: `Student will import without allocation because shift "${shiftName}" is not in this branch.`,
                severity: "info",
            });
        } else {
            result.warnings.push({
                code: "UNKNOWN_SHIFT",
                field: "allocation.shiftName",
                message: `Shift "${shiftName}" does not exist yet.`,
                severity: "warning",
            });
            result.questions.push({
                field: "allocation.shiftName",
                question: `What should happen with unknown shift "${shiftName}"?`,
                options: ["CREATE_SHIFT", "SKIP_UNKNOWN_SHIFT_ALLOCATION"],
            });
        }
    }

    if (multiShiftName && !context.multiShiftsByName.has(multiShiftName.toLowerCase())) {
        if (context.createUnknownMultiShifts) {
            const nameResult = validateRequiredText(multiShiftName, "Multi-shift name", 50);
            if (!nameResult.ok) {
                result.issues.push({
                    code: "INVALID_MULTI_SHIFT_NAME",
                    field: "multiShift.name",
                    message: nameResult.error,
                    severity: "error",
                });
            } else {
                multiShiftName = nameResult.value;
                normalized.multiShift = { ...normalized.multiShift, name: multiShiftName };
                normalized.allocation = { ...normalized.allocation, multiShiftName };
                if (!context.multiShiftsByName.has(multiShiftName.toLowerCase())) {
                    result.warnings.push({
                        code: "WILL_CREATE_MULTI_SHIFT",
                        field: "multiShift.name",
                        message: `Multi-shift "${multiShiftName}" will be created if its component shifts are known.`,
                        severity: "warning",
                    });
                }
            }
        } else if (context.skipUnknownMultiShiftAllocations) {
            result.warnings.push({
                code: "ALLOCATION_SKIPPED_UNKNOWN_MULTI_SHIFT",
                field: "allocation.multiShiftName",
                message: `Student will import without allocation because multi-shift "${multiShiftName}" is not in this branch.`,
                severity: "info",
            });
        } else {
            result.warnings.push({
                code: "UNKNOWN_MULTI_SHIFT",
                field: "allocation.multiShiftName",
                message: `Multi-shift "${multiShiftName}" does not exist yet.`,
                severity: "warning",
            });
            result.questions.push({
                field: "allocation.multiShiftName",
                question: `Create or map unknown multi-shift "${multiShiftName}"?`,
                options: ["CREATE_MULTI_SHIFT", "SKIP_UNKNOWN_MULTI_SHIFT_ALLOCATION"],
            });
        }
    }

    return result;
}
