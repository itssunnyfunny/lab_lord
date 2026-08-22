import type { ImportIssue, ImportNormalizedRow } from "@/importing/contracts/import-session.contract";
import { validateRequiredText } from "@/lib/formValidation";

export type ImportValidationQuestionDraft = {
    rowId?: string;
    field?: string;
    question: string;
    options?: unknown;
};

export type ImportValidatorResult = {
    issues: ImportIssue[];
    warnings: ImportIssue[];
    questions: ImportValidationQuestionDraft[];
};

export function emptyValidatorResult(): ImportValidatorResult {
    return { issues: [], warnings: [], questions: [] };
}

export function validateRequiredImportFields(normalized: ImportNormalizedRow): ImportValidatorResult {
    const result = emptyValidatorResult();
    const nameResult = validateRequiredText(normalized.student?.name, "Student name");

    if (!nameResult.ok) {
        result.issues.push({
            code: nameResult.error === "Student name is required."
                ? "MISSING_STUDENT_NAME"
                : "INVALID_STUDENT_NAME",
            field: "student.name",
            message: nameResult.error,
            severity: "error",
        });
    } else if (normalized.student) {
        // Keep the reviewed mutation identical to StudentService's write-time
        // normalization so an import cannot become a deterministic run failure.
        normalized.student.name = nameResult.value;
    }

    return result;
}

export function mergeValidatorResults(...results: ImportValidatorResult[]): ImportValidatorResult {
    return results.reduce<ImportValidatorResult>((merged, result) => ({
        issues: [...merged.issues, ...result.issues],
        warnings: [...merged.warnings, ...result.warnings],
        questions: [...merged.questions, ...result.questions],
    }), emptyValidatorResult());
}
