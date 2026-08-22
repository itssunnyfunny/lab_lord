import type { ImportGoal, ImportMappingState, ImportOptions, ImportTargetField } from "../contracts/import-session.contract";

export function importTargetAllowedForGoal(
    goal: ImportGoal | null | undefined,
    targetField: ImportTargetField
) {
    if (targetField === "ignore" || targetField.startsWith("student.")) return true;
    if (goal === "STUDENTS") return false;
    if (goal === "STUDENTS_ALLOCATIONS" && targetField.startsWith("payment.")) return false;
    return true;
}

export function applyImportGoalMappingPolicy(
    goal: ImportGoal | null | undefined,
    mapping: ImportMappingState
): ImportMappingState {
    const entityTypesDetected = mapping.entityTypesDetected.filter(entity =>
        entity === "STUDENT"
        || (goal !== "STUDENTS" && entity !== "PAYMENT")
        || goal === "FULL"
    );
    return {
        ...mapping,
        entityTypesDetected: entityTypesDetected.includes("STUDENT")
            ? entityTypesDetected
            : ["STUDENT", ...entityTypesDetected],
        columnMappings: mapping.columnMappings.map(column =>
            importTargetAllowedForGoal(goal, column.targetField)
                ? column
                : {
                    ...column,
                    targetField: "ignore",
                    reason: "Ignored for the selected import goal.",
                    autoApplied: false,
                    needsReview: false,
                }
        ),
        questions: mapping.questions?.filter(question =>
            !question.field
            || importTargetAllowedForGoal(goal, question.field as ImportTargetField)
        ),
        importOptions: applyImportGoalPolicy(goal, mapping.importOptions),
    };
}

export function applyImportGoalPolicy(
    goal: ImportGoal | null | undefined,
    options: Partial<ImportOptions> | null | undefined
): ImportOptions {
    const current = { ...(options ?? {}) };

    if (goal === "STUDENTS") {
        return {
            ...current,
            paymentCycle: "SKIP_PAYMENTS",
            paymentAction: "SKIP_PAYMENTS",
            createUnknownSeats: false,
            createUnknownShifts: false,
            createUnknownMultiShifts: false,
            skipUnknownSeatAllocations: true,
            skipUnknownShiftAllocations: true,
            skipUnknownMultiShiftAllocations: true,
            skipMissingShiftAllocations: true,
            skipConflictingAllocations: true,
        };
    }

    if (goal === "STUDENTS_ALLOCATIONS") {
        return {
            ...current,
            paymentCycle: "SKIP_PAYMENTS",
            paymentAction: "SKIP_PAYMENTS",
        };
    }

    return current;
}
