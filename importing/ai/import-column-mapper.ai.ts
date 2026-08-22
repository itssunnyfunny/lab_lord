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

const MAX_AI_SAMPLE_ROWS = 8;
const MAX_AI_HEADER_LENGTH = 80;
const SAFE_HEADER_TOKENS = new Set([
    "student", "name", "first", "last", "full", "father", "mother", "guardian",
    "phone", "mobile", "contact", "number", "no", "joined", "joining", "date",
    "monthly", "fee", "fees", "amount", "price", "seat", "desk", "shift", "batch",
    "bundle", "multi", "start", "end", "time", "payment", "paid", "due", "status",
    "method", "mode", "reference", "transaction", "id", "legacy", "value", "notes",
    "remark", "remarks", "admission", "history", "current", "previous", "cycle",
    "ledger", "flag", "allocation", "hint",
]);
const AI_QUESTION_FIELDS = new Set([
    "student.joinedAt",
    "seat.label",
    "allocation.shiftName",
    "allocation.multiShiftName",
    "payment.cycle",
    "payment.status",
]);

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

function finiteNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizedHeader(value: string) {
    const redacted = value
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
        .replace(/(?:\+?\d[\d\s().-]{5,}\d)/g, "[redacted-number]")
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/\s+/g, " ")
        .trim();
    if (!redacted) return "unlabeled";
    return redacted
        .split(/\s+/)
        .map(token => {
            if (/^\[redacted-(?:email|number|url)\]$/i.test(token)) return token.toLowerCase();
            const normalized = token.toLocaleLowerCase("en-IN").replace(/[^a-z]/g, "");
            return SAFE_HEADER_TOKENS.has(normalized) ? token : "[redacted-token]";
        })
        .join(" ")
        .slice(0, MAX_AI_HEADER_LENGTH) || "unlabeled";
}

function maskedValueShape(value: unknown) {
    const text = value == null ? "" : String(value).trim();
    if (!text) return "[empty]";
    const digits = text.replace(/\D/g, "");
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return `[email-like:length=${text.length}]`;
    if (/^\+?[\d\s().-]+$/.test(text) && digits.length >= 8) return `[phone-like:digits=${digits.length}]`;
    if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(text)) return "[date-like]";
    if (/^[\p{Sc}\s,.-]*\d[\d\s,.-]*$/u.test(text)) return `[numeric-like:digits=${digits.length}]`;
    return `[text:length=${Array.from(text).length}:words=${text.split(/\s+/).length}]`;
}

function entityTypesForMappings(mappings: ImportMappingResult["columnMappings"]) {
    const types = new Set<ImportMappingResult["entityTypesDetected"][number]>();
    for (const mapping of mappings) {
        if (mapping.targetField.startsWith("student.")) types.add("STUDENT");
        if (mapping.targetField.startsWith("seat.")) types.add("SEAT");
        if (mapping.targetField.startsWith("shift.") || mapping.targetField.startsWith("multiShift.")) types.add("SHIFT");
        if (mapping.targetField.startsWith("allocation.")) types.add("ALLOCATION");
        if (mapping.targetField.startsWith("payment.")) types.add("PAYMENT");
    }
    if (types.size === 0) types.add("STUDENT");
    return Array.from(types);
}

function structuralBranchSummary(value: unknown) {
    if (!isRecord(value)) return {};
    return {
        seatCount: Array.isArray(value.seats) ? value.seats.length : undefined,
        shiftCount: Array.isArray(value.shifts) ? value.shifts.length : undefined,
        multiShiftCount: Array.isArray(value.multiShifts) ? value.multiShifts.length : undefined,
        hasDefaultFee: finiteNumber(value.defaultFee) !== undefined,
        hasDefaultAdmissionFee: finiteNumber(value.defaultAdmissionFee) !== undefined,
    };
}

export type RedactedImportMappingInput = {
    promptInput: Parameters<typeof buildImportColumnMappingPrompt>[0];
    aliasToColumn: ReadonlyMap<string, string>;
    deterministicMappings: ImportMappingResult["columnMappings"];
    ambiguousColumns: string[];
};

export function buildRedactedImportMappingInput(input: {
    branchContext: unknown;
    sourceProfile?: unknown;
    columns: string[];
    sampleRows: ParsedImportRow[];
}): RedactedImportMappingInput {
    const deterministicMappings = buildFallbackMappings(input.columns);
    const ambiguousColumns = deterministicMappings
        .filter(mapping => mapping.targetField === "ignore" || mapping.needsReview)
        .map(mapping => mapping.sourceColumn);
    const aliasToColumn = new Map<string, string>();
    const columnToAlias = new Map<string, string>();
    for (const column of ambiguousColumns) {
        const position = input.columns.indexOf(column) + 1;
        const alias = `column_${position}: ${sanitizedHeader(column)}`;
        aliasToColumn.set(alias, column);
        columnToAlias.set(column, alias);
    }

    const maskedRows = input.sampleRows.slice(0, MAX_AI_SAMPLE_ROWS).map(row =>
        Object.fromEntries(ambiguousColumns.map(column => [
            columnToAlias.get(column) as string,
            maskedValueShape(row[column]),
        ]))
    );
    const sourceRowCount = isRecord(input.sourceProfile) ? finiteNumber(input.sourceProfile.rowCount) : undefined;
    const structuralColumns = ambiguousColumns.map(column => {
        const alias = columnToAlias.get(column) as string;
        const values = input.sampleRows.map(row => row[column]);
        const filledValues = values.filter(value => String(value ?? "").trim().length > 0);
        const shapes = Array.from(new Set(filledValues.map(maskedValueShape))).slice(0, 5);
        return {
            column: alias,
            filledSampleRows: filledValues.length,
            emptySampleRows: values.length - filledValues.length,
            uniqueSampleValueCount: new Set(filledValues.map(value => String(value))).size,
            observedShapes: shapes,
        };
    });

    return {
        deterministicMappings,
        ambiguousColumns,
        aliasToColumn,
        promptInput: {
            branchContext: structuralBranchSummary(input.branchContext),
            sourceProfile: {
                rowCount: sourceRowCount ?? input.sampleRows.length,
                ambiguousColumnCount: ambiguousColumns.length,
                columns: structuralColumns,
            },
            columns: Array.from(aliasToColumn.keys()),
            sampleRows: maskedRows,
        },
    };
}

function advisoryText(value: unknown, maxLength: number) {
    if (typeof value !== "string") return "";
    return value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

function stringsFrom(value: unknown, maxItems = 20, maxLength = 128) {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, maxItems)
        .map(item => advisoryText(item, maxLength))
        .filter(Boolean);
}

function sanitizeSuggestedImportOptions(value: unknown): Partial<ImportOptions> | undefined {
    if (!isRecord(value)) return undefined;
    const next: Partial<ImportOptions> = {};

    if (typeof value.paymentCycle === "string" && [
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

function sanitizeMappingResult(
    value: unknown,
    columns: string[],
    aiTrace?: ImportAITrace,
    reservedTargets: ReadonlySet<ImportTargetField> = new Set()
): ImportMappingResult | null {
    if (!value || typeof value !== "object") return null;
    const result = value as Record<string, unknown>;
    const columnMappingsInput = Array.isArray(result.columnMappings) ? result.columnMappings : [];
    const columnSet = new Set(columns);
    const warnings = stringsFrom(result.warnings, 20, 300);
    const seenColumns = new Set<string>();
    const seenTargets = new Set<ImportTargetField>(reservedTargets);

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
                reason: advisoryText(item.reason, 300) || undefined,
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
              .slice(0, 20)
              .filter(isRecord)
              .map(item => ({
                  field: typeof item.field === "string" && AI_QUESTION_FIELDS.has(item.field)
                      ? item.field
                      : undefined,
                  question: advisoryText(item.question, 240),
                  options: stringsFrom(item.options, 20, 100),
              }))
              .filter(item => item.question)
        : [];

    return {
        entityTypesDetected,
        columnMappings,
        questions,
        warnings,
        suggestedImportOptions: sanitizeSuggestedImportOptions(result.suggestedImportOptions),
        analysisNotes: stringsFrom(result.analysisNotes, 5, 300),
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
    const redacted = buildRedactedImportMappingInput(input);
    if (redacted.ambiguousColumns.length === 0) {
        return {
            entityTypesDetected: entityTypesForMappings(redacted.deterministicMappings),
            columnMappings: redacted.deterministicMappings,
            questions: [],
            warnings: [],
            usedFallback: false,
        };
    }

    const model = resolveGeminiProModel();
    const attemptedAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
        const result = await callGeminiJson<unknown>(buildImportColumnMappingPrompt(redacted.promptInput), {
            model,
            responseJsonSchema: IMPORT_COLUMN_MAPPING_SCHEMA,
        });
        const durationMs = Date.now() - startedAt;
        if (result.ok) {
            const reservedTargets = new Set<ImportTargetField>(redacted.deterministicMappings
                .map(mapping => mapping.targetField)
                .filter((target): target is ImportTargetField => target !== "ignore"));
            const sanitized = sanitizeMappingResult(result.data, redacted.promptInput.columns, {
                status: "success",
                model,
                attemptedAt,
                durationMs,
                usedStructuredOutput: true,
            }, reservedTargets);
            if (sanitized) {
                const aiMappings = sanitized.columnMappings.map(mapping => ({
                    ...mapping,
                    sourceColumn: redacted.aliasToColumn.get(mapping.sourceColumn) ?? mapping.sourceColumn,
                }));
                const aiByColumn = new Map(aiMappings.map(mapping => [mapping.sourceColumn, mapping]));
                const columnMappings = redacted.deterministicMappings.map(mapping =>
                    redacted.ambiguousColumns.includes(mapping.sourceColumn)
                        ? aiByColumn.get(mapping.sourceColumn) ?? mapping
                        : mapping
                );
                return {
                    ...sanitized,
                    entityTypesDetected: Array.from(new Set([
                        ...entityTypesForMappings(columnMappings),
                        ...sanitized.entityTypesDetected,
                    ])),
                    columnMappings,
                };
            }

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
