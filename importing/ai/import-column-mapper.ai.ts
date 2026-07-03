import { callGeminiJson, resolveGeminiProModel } from "@/ai/llm/gemini.client";
import {
    IMPORT_TARGET_FIELDS,
    type ImportAITrace,
    type ImportMappingResult,
    type ImportOptions,
    type ImportTargetField,
    type ParsedImportRow,
} from "@/importing/contracts/import-session.contract";
import { buildFallbackMappings } from "@/importing/utils/column-normalizer";
import { buildImportColumnMappingPrompt } from "./prompts/import-column-mapping.prompt";

const IMPORT_COLUMN_MAPPING_SCHEMA = {
    type: "object",
    properties: {
        entityTypesDetected: {
            type: "array",
            items: { type: "string", enum: ["STUDENT", "SEAT", "SHIFT", "ALLOCATION", "PAYMENT"] },
        },
        columnMappings: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    sourceColumn: { type: "string" },
                    targetField: { type: "string", enum: IMPORT_TARGET_FIELDS },
                    confidence: { type: "number" },
                    reason: { type: "string" },
                },
                required: ["sourceColumn", "targetField", "confidence"],
            },
        },
        questions: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    field: { type: "string" },
                    question: { type: "string" },
                    options: { type: "array", items: { type: "string" } },
                },
                required: ["question"],
            },
        },
        warnings: { type: "array", items: { type: "string" } },
        suggestedImportOptions: { type: "object" },
        analysisNotes: { type: "array", items: { type: "string" } },
    },
    required: ["entityTypesDetected", "columnMappings", "questions", "warnings"],
};

function isTargetField(value: unknown): value is ImportTargetField {
    return typeof value === "string" && (IMPORT_TARGET_FIELDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringsFrom(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sanitizeSuggestedImportOptions(value: unknown): Partial<ImportOptions> | undefined {
    if (!isRecord(value)) return undefined;
    const next: Partial<ImportOptions> = {};

    if (typeof value.paymentCycle === "string" && [
        "CURRENT_MONTH",
        "PREVIOUS_MONTH",
        "CUSTOM_PERIOD",
        "USE_JOINED_AT_ANNIVERSARY",
        "SKIP_PAYMENTS",
    ].includes(value.paymentCycle)) {
        next.paymentCycle = value.paymentCycle as ImportOptions["paymentCycle"];
    }

    if (typeof value.paymentAction === "string" && [
        "GENERATE_DUE",
        "IMPORT_PAID_UNPAID",
        "SKIP_PAYMENTS",
    ].includes(value.paymentAction)) {
        next.paymentAction = value.paymentAction as ImportOptions["paymentAction"];
    }

    if (typeof value.paymentHistoryMode === "string" && [
        "START_CURRENT_JOINED_CYCLE",
        "FROM_JOINED_MARK_PAID",
        "FROM_JOINED_MARK_DUE",
        "FROM_JOINED_PAID_THROUGH_PREVIOUS",
    ].includes(value.paymentHistoryMode)) {
        next.paymentHistoryMode = value.paymentHistoryMode as ImportOptions["paymentHistoryMode"];
    }

    if (typeof value.customPeriodStart === "string") next.customPeriodStart = value.customPeriodStart;
    if (typeof value.customPeriodEnd === "string") next.customPeriodEnd = value.customPeriodEnd;
    if (typeof value.skipUnknownSeatAllocations === "boolean") next.skipUnknownSeatAllocations = value.skipUnknownSeatAllocations;
    if (typeof value.skipUnknownShiftAllocations === "boolean") next.skipUnknownShiftAllocations = value.skipUnknownShiftAllocations;
    if (typeof value.skipUnknownMultiShiftAllocations === "boolean") next.skipUnknownMultiShiftAllocations = value.skipUnknownMultiShiftAllocations;
    if (typeof value.skipMissingShiftAllocations === "boolean") next.skipMissingShiftAllocations = value.skipMissingShiftAllocations;
    if (typeof value.skipConflictingAllocations === "boolean") next.skipConflictingAllocations = value.skipConflictingAllocations;

    if (isRecord(value.paymentMapping)) {
        next.paymentMapping = {
            paidValues: stringsFrom(value.paymentMapping.paidValues),
            unpaidValues: stringsFrom(value.paymentMapping.unpaidValues),
            waivedValues: stringsFrom(value.paymentMapping.waivedValues),
            unclearValues: stringsFrom(value.paymentMapping.unclearValues),
            confirmed: false,
        };
    }

    return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeMappingResult(value: unknown, columns: string[], aiTrace?: ImportAITrace): ImportMappingResult | null {
    if (!value || typeof value !== "object") return null;
    const result = value as Record<string, unknown>;
    const columnMappingsInput = Array.isArray(result.columnMappings) ? result.columnMappings : [];
    const columnSet = new Set(columns);
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === "string") : [];
    const seenColumns = new Set<string>();
    const seenTargets = new Set<ImportTargetField>();

    const validCandidateMappings = columnMappingsInput
        .filter(isRecord)
        .filter(item => typeof item.sourceColumn === "string" && columnSet.has(item.sourceColumn) && isTargetField(item.targetField))
        .map(item => {
            const sourceColumn = item.sourceColumn as string;
            const targetField = item.targetField as ImportTargetField;
            const duplicateColumn = seenColumns.has(sourceColumn);

            if (duplicateColumn) {
                warnings.push(`Gemini mapped "${sourceColumn}" more than once; the first mapping was kept.`);
                return null;
            }
            seenColumns.add(sourceColumn);

            const confidence = Math.max(0, Math.min(100, Number(item.confidence) || 50));
            if (targetField !== "ignore" && confidence < 85) {
                warnings.push(`Gemini was unsure about "${sourceColumn}" -> "${targetField}"; the column was left for review.`);
                return {
                    sourceColumn,
                    targetField: "ignore" as const,
                    confidence,
                    reason: `AI mapping to "${targetField}" needs review before it can be applied.`,
                    source: "AI" as const,
                    autoApplied: false,
                    needsReview: true,
                };
            }

            const duplicateTarget = targetField !== "ignore" && seenTargets.has(targetField);

            if (duplicateTarget) {
                warnings.push(`Gemini mapped more than one column to "${targetField}"; "${sourceColumn}" was left for review.`);
                return {
                    sourceColumn,
                    targetField: "ignore" as const,
                    confidence: 40,
                    reason: `Duplicate target "${targetField}" needs manual review.`,
                    source: "AI" as const,
                    autoApplied: false,
                    needsReview: true,
                };
            }

            if (targetField !== "ignore") seenTargets.add(targetField);

            return {
                sourceColumn,
                targetField,
                confidence,
                reason: typeof item.reason === "string" ? item.reason : undefined,
                source: "AI" as const,
                autoApplied: targetField !== "ignore",
                needsReview: false,
            };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

    if (validCandidateMappings.length === 0) return null;

    const columnMappings = [...validCandidateMappings];
    const mappedColumns = new Set(columnMappings.map(mapping => mapping.sourceColumn));
    for (const column of columns) {
        if (!mappedColumns.has(column)) {
            columnMappings.push({
                sourceColumn: column,
                targetField: "ignore",
                confidence: 35,
                reason: "AI did not map this column.",
                source: "AI",
                autoApplied: false,
                needsReview: true,
            });
        }
    }

    const entityTypesDetected = Array.isArray(result.entityTypesDetected)
        ? result.entityTypesDetected.filter((item): item is ImportMappingResult["entityTypesDetected"][number] =>
              typeof item === "string" && ["STUDENT", "SEAT", "SHIFT", "ALLOCATION", "PAYMENT"].includes(item)
          )
        : [];

    const questions = Array.isArray(result.questions)
        ? result.questions
              .filter(isRecord)
              .map(item => ({
                  field: typeof item.field === "string" ? item.field : undefined,
                  question: typeof item.question === "string" ? item.question : "",
                  options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === "string") : undefined,
              }))
              .filter(item => item.question)
        : [];

    return {
        entityTypesDetected,
        columnMappings,
        questions,
        warnings,
        suggestedImportOptions: sanitizeSuggestedImportOptions(result.suggestedImportOptions),
        analysisNotes: stringsFrom(result.analysisNotes).slice(0, 5),
        model: resolveGeminiProModel(),
        aiTrace,
    };
}

export async function mapImportColumns(input: {
    branchContext: unknown;
    sourceProfile?: unknown;
    columns: string[];
    sampleRows: ParsedImportRow[];
}): Promise<ImportMappingResult> {
    const model = resolveGeminiProModel();
    const attemptedAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
        const result = await callGeminiJson<unknown>(buildImportColumnMappingPrompt(input), {
            model,
            responseJsonSchema: IMPORT_COLUMN_MAPPING_SCHEMA,
        });
        const durationMs = Date.now() - startedAt;
        if (result.ok) {
            const sanitized = sanitizeMappingResult(result.data, input.columns, {
                status: "success",
                model,
                attemptedAt,
                durationMs,
                usedStructuredOutput: true,
            });
            if (sanitized) return sanitized;

            return fallbackMapping(input.columns, {
                status: "invalid_response",
                model,
                attemptedAt,
                durationMs,
                fallbackReason: "Gemini JSON did not contain a usable column mapping.",
                usedStructuredOutput: true,
            });
        }
        return fallbackMapping(input.columns, {
            status: result.rawText ? "invalid_response" : "unavailable",
            model,
            attemptedAt,
            durationMs,
            fallbackReason: result.error,
            error: result.error,
            usedStructuredOutput: true,
        });
    } catch {
        return fallbackMapping(input.columns, {
            status: "error",
            model,
            attemptedAt,
            durationMs: Date.now() - startedAt,
            fallbackReason: "Gemini mapping failed before a structured response was available.",
            usedStructuredOutput: true,
        });
    }
}

function fallbackMapping(columns: string[], aiTrace: ImportAITrace): ImportMappingResult {
    return {
        entityTypesDetected: ["STUDENT"],
        columnMappings: buildFallbackMappings(columns),
        questions: [],
        warnings: [aiTrace.fallbackReason ?? "AI mapping was unavailable, so deterministic column matching was used."],
        model: aiTrace.model,
        usedFallback: true,
        aiTrace: {
            ...aiTrace,
            status: aiTrace.status === "success" ? "fallback" : aiTrace.status,
        },
    };
}
