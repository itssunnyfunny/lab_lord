import { prisma } from "@/lib/prisma";
import { StaffService } from "@/services/staff.service";
import { mapImportColumns } from "@/importing/ai/import-column-mapper.ai";
import type {
    CreateImportSessionInput,
    ImportBranchContext,
    ImportColumnMapping,
    ImportIssue,
    ImportMappingState,
    ImportNormalizedRow,
    ImportSessionSummary,
    ImportSourceProfile,
    ParsedImportSource,
} from "@/importing/contracts/import-session.contract";
import { parseCsv } from "@/importing/parsers/csv.parser";
import { parsePdf } from "@/importing/parsers/pdf.parser";
import { parsePastedTable } from "@/importing/parsers/pasted-table.parser";
import { parseXlsx } from "@/importing/parsers/xlsx.parser";
import {
    buildImportAttention,
    buildImportSessionAnalysis,
    buildImportSourceProfile,
    buildImportSourceProfileFromRows,
    hasManualNormalizedData,
    markManualNormalizedData,
} from "@/importing/pipeline/import-extraction.pipeline";
import { detectDuplicateImportRows, detectExistingStudentDuplicates } from "@/importing/utils/duplicate-detector";
import { dedupeImportQuestionDrafts } from "@/importing/utils/import-question-dedupe";
import { findStagedAllocationConflicts, stagedAllocationConflictWarnings } from "@/importing/utils/staged-allocation-conflicts";
import { applyImportDefaults, normalizeImportRow } from "@/importing/utils/row-normalizer";
import { promoteKnownMultiShiftAllocation } from "@/importing/utils/shift-alias-resolver";
import { buildFallbackMappings } from "@/importing/utils/column-normalizer";
import { mergeValidatorResults, validateRequiredImportFields } from "@/importing/validators/import-required-fields.validator";
import { validateImportAllocation } from "@/importing/validators/import-allocation.validator";
import { validateImportPayment } from "@/importing/validators/import-payment.validator";
import { validateImportSeat } from "@/importing/validators/import-seat.validator";
import { validateImportShift } from "@/importing/validators/import-shift.validator";
import { validateImportStudent } from "@/importing/validators/import-student.validator";
import { inferConfirmedPaymentMapping } from "@/importing/utils/payment-mapping-inference";
import type { Prisma } from "@/app/generated/prisma/client";
import type { ImportRowStatus, ImportSessionStatus } from "@/app/generated/prisma/enums";

export type ImportSessionRowFilter = "attention" | "ready" | "all" | "skipped";

export type ImportSessionDetailOptions = {
    rowFilter?: ImportSessionRowFilter;
    limit?: number;
    cursor?: number;
};

export const MAX_IMPORT_ROWS = 2000;

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function toStringDate(value: Date) {
    return value.toISOString();
}

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Something went wrong";
}

function terminalImportSessionStatus(status: string) {
    return ["COMMITTING", "COMMITTED", "PARTIAL", "FAILED"].includes(status);
}

function clampRowLimit(value: number | undefined) {
    if (!value || !Number.isFinite(value)) return undefined;
    return Math.max(1, Math.min(500, Math.floor(value)));
}

function columnsFromFileMeta(meta: unknown): string[] | null {
    if (!meta || typeof meta !== "object" || Array.isArray(meta) || !("columns" in meta)) return null;
    const columns = (meta as { columns?: unknown }).columns;
    return Array.isArray(columns) && columns.every(column => typeof column === "string") ? columns : null;
}

function rowWhereForFilter(
    importSessionId: string,
    filter: ImportSessionRowFilter = "all",
    cursor?: number
): Prisma.ImportRowWhereInput {
    const where: Prisma.ImportRowWhereInput = { importSessionId };
    if (cursor && Number.isFinite(cursor)) where.rowNumber = { gt: cursor };

    if (filter === "ready") where.status = { in: ["READY", "WARNING"] };
    if (filter === "attention") where.status = { in: ["WARNING", "NEEDS_REVIEW", "BLOCKED", "DUPLICATE", "CONFLICT", "FAILED"] };
    if (filter === "skipped") {
        where.OR = [
            { skipped: true },
            { status: "SKIPPED" },
        ];
    }

    return where;
}

async function parseImportSource(input: CreateImportSessionInput): Promise<ParsedImportSource> {
    if (input.sourceType === "PASTED_TABLE") return parsePastedTable(input.pastedTable);
    if (input.sourceType === "CSV") return parseCsv(input.fileBuffer.toString("utf8"));
    if (input.sourceType === "XLSX" || input.sourceType === "XLS") return parseXlsx(input.fileBuffer);
    if (input.sourceType === "PDF") return parsePdf(input.fileBuffer);
    return parseCsv(input.fileBuffer.toString("utf8"));
}

function emptySummary(): ImportSessionSummary {
    return {
        totalRows: 0,
        readyRows: 0,
        needsReviewRows: 0,
        blockedRows: 0,
        warningRows: 0,
        duplicateRows: 0,
        conflictRows: 0,
        skippedRows: 0,
        readinessScore: 0,
        detectedEntityCounts: {
            STUDENT: 0,
            SEAT: 0,
            SHIFT: 0,
            ALLOCATION: 0,
            PAYMENT: 0,
        },
        warnings: [],
    };
}

function summarizeRows(rows: Array<{
    status: ImportRowStatus;
    skipped: boolean;
    normalizedData: unknown;
    warnings: unknown;
}>, input: {
    mapping?: ImportMappingState | null;
    sourceProfile?: ImportSourceProfile;
    openQuestions?: number;
} = {}): ImportSessionSummary {
    const summary = emptySummary();
    summary.totalRows = rows.length;
    summary.warnings = input.mapping?.warnings ?? [];
    summary.openQuestions = input.openQuestions ?? 0;
    summary.attention = input.mapping?.analysis?.attention ?? [];
    summary.sourceProfile = input.sourceProfile;

    for (const row of rows) {
        if (row.status === "READY") summary.readyRows++;
        if (row.status === "NEEDS_REVIEW") summary.needsReviewRows++;
        if (row.status === "BLOCKED") summary.blockedRows++;
        if (row.status === "WARNING") summary.warningRows++;
        if (row.status === "DUPLICATE") summary.duplicateRows++;
        if (row.status === "CONFLICT") summary.conflictRows++;
        if (row.status === "SKIPPED" || row.skipped) summary.skippedRows++;

        const normalized = row.normalizedData as ImportNormalizedRow | null;
        if (normalized?.student?.name) summary.detectedEntityCounts.STUDENT++;
        if (normalized?.seat?.label) summary.detectedEntityCounts.SEAT++;
        if (normalized?.shift?.name) summary.detectedEntityCounts.SHIFT++;
        if (normalized?.allocation?.seatLabel && (normalized.allocation.shiftName || normalized.allocation.multiShiftName)) summary.detectedEntityCounts.ALLOCATION++;
        if (normalized?.payment?.amount || normalized?.payment?.rawStatus) summary.detectedEntityCounts.PAYMENT++;

        const rowWarnings = Array.isArray(row.warnings) ? row.warnings as ImportIssue[] : [];
        for (const warning of rowWarnings) {
            if (summary.warnings.length < 10) summary.warnings.push(warning.message);
        }
    }

    const importableRows = summary.readyRows + summary.warningRows;
    summary.readinessScore = summary.totalRows > 0
        ? Math.round((importableRows / summary.totalRows) * 100)
        : 0;

    return summary;
}

export function normalizeMapping(mapping: unknown, columns: string[]): ImportMappingState {
    if (!mapping || typeof mapping !== "object") {
        return {
            entityTypesDetected: ["STUDENT"],
            columnMappings: buildFallbackMappings(columns),
            warnings: ["Manual mapping is required."],
            usedFallback: true,
        };
    }

    const state = mapping as Partial<ImportMappingState>;
    const columnMappings = Array.isArray(state.columnMappings) && state.columnMappings.length > 0
        ? state.columnMappings
        : buildFallbackMappings(columns);

    return {
        entityTypesDetected: state.entityTypesDetected ?? ["STUDENT"],
        columnMappings,
        questions: state.questions ?? [],
        warnings: state.warnings ?? [],
        importOptions: state.importOptions ?? {},
        analysis: state.analysis,
        usedFallback: state.usedFallback,
    };
}

function sourceProfileFromSession(input: {
    fileMeta: unknown;
    rows: { rawData: unknown }[];
}, columns: string[]): ImportSourceProfile {
    const meta = input.fileMeta;
    if (
        meta &&
        typeof meta === "object" &&
        !Array.isArray(meta) &&
        "sourceProfile" in meta
    ) {
        return (meta as { sourceProfile: ImportSourceProfile }).sourceProfile;
    }

    return buildImportSourceProfileFromRows(
        columns,
        input.rows.map(row => row.rawData as Record<string, string>)
    );
}

function mappingWithComputedAnalysis(input: {
    mapping: ImportMappingState;
    sourceProfile: ImportSourceProfile;
    rows: Array<{
        rowNumber: number;
        status: string;
        skipped?: boolean;
        issues?: unknown;
        warnings?: unknown;
        confidence?: number | null;
    }>;
    questions: Array<{
        status: string;
        field?: string | null;
        rowId?: string | null;
    }>;
    sessionStatus?: string;
    detectedPaymentValues?: string[];
}): ImportMappingState {
    const existing = input.mapping.analysis;
    const attention = existing?.attention?.length
        ? existing.attention
        : buildImportAttention({
            rows: input.rows,
            questions: input.questions,
            mapping: input.mapping,
        });
    const computed = buildImportSessionAnalysis({
        sourceProfile: existing?.sourceProfile ?? input.sourceProfile,
        attention,
        mapping: input.mapping,
        sessionStatus: input.sessionStatus,
        model: existing?.model,
        notes: existing?.notes,
        ai: existing?.ai,
        detectedPaymentValues: existing?.detectedPaymentValues ?? input.detectedPaymentValues,
    });

    return {
        ...input.mapping,
        analysis: {
            ...computed,
            ...(existing ?? {}),
            sourceProfile: existing?.sourceProfile ?? computed.sourceProfile,
            attention,
            pipeline: existing?.pipeline?.length ? existing.pipeline : computed.pipeline,
        },
    };
}

async function getImportBranchContext(branchId: string): Promise<ImportBranchContext> {
    const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: {
            defaultFee: true,
            defaultAdmissionFee: true,
            seats: { select: { id: true, label: true }, orderBy: { label: "asc" } },
            shifts: {
                where: { status: "ACTIVE" },
                select: { id: true, name: true, startTime: true, endTime: true, price: true },
                orderBy: { name: "asc" },
            },
            multiShifts: {
                select: {
                    id: true,
                    name: true,
                    price: true,
                    components: {
                        include: { shift: { select: { name: true } } },
                        orderBy: { order: "asc" },
                    },
                },
                orderBy: { name: "asc" },
            },
        },
    });

    if (!branch) throw new Error("Branch not found");

    return {
        defaultFee: branch.defaultFee ?? 0,
        defaultAdmissionFee: branch.defaultAdmissionFee ?? 0,
        seats: branch.seats,
        shifts: branch.shifts,
        multiShifts: branch.multiShifts.map(multiShift => ({
            id: multiShift.id,
            name: multiShift.name,
            price: multiShift.price,
            componentShiftNames: multiShift.components.map(component => component.shift.name),
        })),
    };
}

export function statusForValidation(input: {
    skipped: boolean;
    issues: ImportIssue[];
    warnings: ImportIssue[];
}): ImportRowStatus {
    if (input.skipped) return "SKIPPED";
    if (input.issues.some(issue => issue.code === "ALLOCATION_CONFLICT" || issue.code === "STAGED_ALLOCATION_CONFLICT")) return "CONFLICT";
    if (input.issues.length > 0) return "BLOCKED";
    const reviewWarnings = input.warnings.filter(warning => warning.severity !== "info");
    if (reviewWarnings.some(warning => warning.code.includes("DUPLICATE"))) return "DUPLICATE";
    if (reviewWarnings.some(warning =>
        warning.code.includes("UNKNOWN") ||
        warning.code.includes("REQUIRED") ||
        warning.code.includes("UNCONFIRMED") ||
        warning.code.includes("AMBIGUOUS") ||
        warning.code.includes("MISSING_ALLOCATION")
    )) return "NEEDS_REVIEW";
    if (input.warnings.length > 0) return "WARNING";
    return "READY";
}

export function assertImportRowLimit(rowCount: number) {
    if (rowCount > MAX_IMPORT_ROWS) {
        throw new Error(`This import has ${rowCount.toLocaleString("en-IN")} rows. The current wizard supports up to ${MAX_IMPORT_ROWS.toLocaleString("en-IN")} rows per import.`);
    }
}

export class ImportSessionService {
    private static async authorize(userId: string, branchId: string) {
        await StaffService.authorize(userId, branchId, "students");
    }

    static async createSession(userId: string, branchId: string, input: CreateImportSessionInput) {
        await this.authorize(userId, branchId);
        const parsed = await parseImportSource(input);
        assertImportRowLimit(parsed.rows.length);
        const sourceProfile = buildImportSourceProfile(parsed);

        const session = await prisma.$transaction(async tx => {
            const created = await tx.importSession.create({
                data: {
                    branchId,
                    uploadedByUserId: userId,
                    sourceType: input.sourceType,
                    fileName: input.fileName,
                    fileMeta: asJson({
                        ...(input.fileMeta ?? {}),
                        columns: parsed.columns,
                        rowCount: parsed.rows.length,
                        sourceProfile,
                    }),
                    summary: asJson({ ...emptySummary(), totalRows: parsed.rows.length, sourceProfile }),
                },
            });

            const chunkSize = 500;
            for (let index = 0; index < parsed.rows.length; index += chunkSize) {
                await tx.importRow.createMany({
                    data: parsed.rows.slice(index, index + chunkSize).map((row, offset) => ({
                        importSessionId: created.id,
                        rowNumber: index + offset + 2,
                        rawData: asJson(row),
                    })),
                });
            }

            return created;
        });

        return {
            id: session.id,
            rowCount: parsed.rows.length,
            columns: parsed.columns,
            status: session.status,
        };
    }

    static async listSessions(userId: string, branchId: string) {
        await this.authorize(userId, branchId);
        const sessions = await prisma.importSession.findMany({
            where: { branchId },
            orderBy: { createdAt: "desc" },
            take: 30,
        });

        return sessions.map(session => ({
            id: session.id,
            branchId: session.branchId,
            sourceType: session.sourceType,
            fileName: session.fileName,
            status: session.status,
            summary: session.summary as ImportSessionSummary | null,
            createdAt: toStringDate(session.createdAt),
            updatedAt: toStringDate(session.updatedAt),
        }));
    }

    static async getSessionDetail(
        userId: string,
        branchId: string,
        sessionId: string,
        options: ImportSessionDetailOptions = {}
    ) {
        await this.authorize(userId, branchId);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: {
                questions: { orderBy: { createdAt: "asc" } },
                commits: { orderBy: { createdAt: "desc" } },
            },
        });

        if (!session) throw new Error("Import session not found");
        const firstRow = await prisma.importRow.findFirst({
            where: { importSessionId: sessionId },
            orderBy: { rowNumber: "asc" },
            select: { rawData: true },
        });
        const columns = columnsFromFileMeta(session.fileMeta)
            ?? Object.keys((firstRow?.rawData ?? {}) as Record<string, unknown>);
        const needsSourceProfileFallback = !(
            session.fileMeta &&
            typeof session.fileMeta === "object" &&
            !Array.isArray(session.fileMeta) &&
            "sourceProfile" in session.fileMeta
        );
        const profileRows = needsSourceProfileFallback
            ? await prisma.importRow.findMany({
                where: { importSessionId: sessionId },
                orderBy: { rowNumber: "asc" },
                select: { rawData: true },
            })
            : [];
        const sourceProfile = sourceProfileFromSession({
            fileMeta: session.fileMeta,
            rows: profileRows,
        }, columns);
        const summaryRows = await prisma.importRow.findMany({
            where: { importSessionId: sessionId },
            orderBy: { rowNumber: "asc" },
            select: {
                id: true,
                rowNumber: true,
                status: true,
                skipped: true,
                normalizedData: true,
                issues: true,
                warnings: true,
                confidence: true,
            },
        });
        const openQuestions = session.questions.filter(question => question.status === "OPEN").length;
        const mapping = mappingWithComputedAnalysis({
            mapping: normalizeMapping(session.mapping, columns),
            sourceProfile,
            rows: summaryRows,
            questions: session.questions,
            sessionStatus: session.status,
        });
        const branchContext = await getImportBranchContext(branchId);
        const summary = summarizeRows(summaryRows, {
            mapping,
            sourceProfile,
            openQuestions,
        });
        const filter = options.rowFilter ?? "all";
        const limit = clampRowLimit(options.limit);
        const rowsWhere = rowWhereForFilter(sessionId, filter, options.cursor);
        const pageRows = await prisma.importRow.findMany({
            where: rowsWhere,
            orderBy: { rowNumber: "asc" },
            ...(limit ? { take: limit + 1 } : {}),
        });
        const hasMore = Boolean(limit && pageRows.length > limit);
        const returnedRows = hasMore && limit ? pageRows.slice(0, limit) : pageRows;
        const filteredRows = options.rowFilter || limit || options.cursor
            ? await prisma.importRow.count({ where: rowWhereForFilter(sessionId, filter) })
            : summaryRows.length;
        const nextCursor = hasMore && returnedRows.length > 0
            ? String(returnedRows[returnedRows.length - 1].rowNumber)
            : null;

        return {
            ...session,
            createdAt: toStringDate(session.createdAt),
            updatedAt: toStringDate(session.updatedAt),
            mapping,
            summary,
            rowPage: {
                filter,
                limit: limit ?? null,
                cursor: options.cursor ? String(options.cursor) : null,
                nextCursor,
                hasMore,
                totalRows: summaryRows.length,
                filteredRows,
                returnedRows: returnedRows.length,
            },
            branchContext,
            rows: returnedRows.map(row => ({
                id: row.id,
                rowNumber: row.rowNumber,
                rawData: row.rawData,
                mappedData: row.mappedData,
                normalizedData: row.normalizedData,
                status: row.status,
                issues: row.issues ?? [],
                warnings: row.warnings ?? [],
                confidence: row.confidence,
                skipped: row.skipped,
                createdEntityIds: row.createdEntityIds,
            })),
            questions: session.questions.map(question => ({
                id: question.id,
                rowId: question.rowId,
                field: question.field,
                question: question.question,
                options: question.options,
                answer: question.answer,
                status: question.status,
                createdAt: toStringDate(question.createdAt),
                answeredAt: question.answeredAt ? toStringDate(question.answeredAt) : null,
            })),
            commits: session.commits.map(commit => ({
                id: commit.id,
                status: commit.status,
                summary: commit.summary,
                errors: commit.errors,
                createdAt: toStringDate(commit.createdAt),
            })),
        };
    }

    private static async getValidationContext(branchId: string) {
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            select: {
                defaultFee: true,
                defaultAdmissionFee: true,
                seats: { select: { id: true, label: true } },
                shifts: {
                    where: { status: "ACTIVE" },
                    select: { id: true, name: true, startTime: true, endTime: true, price: true },
                },
                multiShifts: {
                    select: {
                        id: true,
                        name: true,
                        price: true,
                        components: { include: { shift: { select: { id: true, name: true } } } },
                    },
                },
                students: {
                    select: {
                        id: true,
                        name: true,
                        phone: true,
                        joinedAt: true,
                        seatAllocations: {
                            where: { endDate: null },
                            include: { seat: { select: { label: true } }, shift: { select: { name: true } } },
                        },
                    },
                },
            },
        });

        if (!branch) throw new Error("Branch not found");
        const activeAllocations = await prisma.seatAllocation.findMany({
            where: { endDate: null, seat: { branchId } },
            include: { seat: { select: { label: true } }, shift: { select: { name: true, startTime: true, endTime: true } } },
        });

        return {
            branchDefaultFee: branch.defaultFee ?? 0,
            defaultAdmissionFee: branch.defaultAdmissionFee ?? 0,
            seatsByLabel: new Map(branch.seats.map(seat => [seat.label.toLowerCase(), seat])),
            shiftsByName: new Map(branch.shifts.map(shift => [shift.name.toLowerCase(), shift])),
            multiShiftsByName: new Map(branch.multiShifts.map(multiShift => [
                multiShift.name.toLowerCase(),
                {
                    id: multiShift.id,
                    name: multiShift.name,
                    price: multiShift.price,
                    components: multiShift.components.map(component => ({
                        shiftId: component.shift.id,
                        shiftName: component.shift.name,
                    })),
                },
            ])),
            existingStudents: branch.students,
            activeAllocations,
            aiBranchContext: {
                defaultFee: branch.defaultFee ?? 0,
                defaultAdmissionFee: branch.defaultAdmissionFee ?? 0,
                seats: branch.seats.map(seat => seat.label),
                shifts: branch.shifts.map(shift => ({
                    name: shift.name,
                    startTime: shift.startTime,
                    endTime: shift.endTime,
                    price: shift.price,
                })),
                multiShifts: branch.multiShifts.map(multiShift => ({
                    name: multiShift.name,
                    price: multiShift.price,
                    componentShiftNames: multiShift.components.map(component => component.shift.name),
                })),
            },
        };
    }

    static async analyzeSession(userId: string, branchId: string, sessionId: string) {
        await this.authorize(userId, branchId);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: { rows: { orderBy: { rowNumber: "asc" } } },
        });
        if (!session) throw new Error("Import session not found");
        if (terminalImportSessionStatus(session.status)) {
            return this.getSessionDetail(userId, branchId, sessionId);
        }

        await prisma.importSession.update({
            where: { id: sessionId },
            data: { status: "ANALYZING" },
        });

        try {
            const columns = Object.keys((session.rows[0]?.rawData ?? {}) as Record<string, unknown>);
            const sourceProfile = sourceProfileFromSession(session, columns);
            const context = await this.getValidationContext(branchId);
            const aiMapping = await mapImportColumns({
                branchContext: context.aiBranchContext,
                sourceProfile,
                columns,
                sampleRows: session.rows.slice(0, 8).map(row => row.rawData as Record<string, string>),
            });

            const mapping: ImportMappingState = {
                ...aiMapping,
                importOptions: aiMapping.suggestedImportOptions ?? {},
                analysis: buildImportSessionAnalysis({
                    sourceProfile,
                    attention: [],
                    model: aiMapping.model,
                    notes: aiMapping.analysisNotes,
                    ai: aiMapping.aiTrace,
                }),
            };

            await prisma.importSession.update({
                where: { id: sessionId },
                data: { mapping: asJson(mapping) },
            });

            return this.revalidateSession(userId, branchId, sessionId);
        } catch (error) {
            await prisma.importSession.update({
                where: { id: sessionId },
                data: {
                    status: "NEEDS_MAPPING",
                    summary: asJson({
                        ...emptySummary(),
                        warnings: [getErrorMessage(error)],
                    }),
                },
            });
            throw error;
        }
    }

    static async updateMapping(
        userId: string,
        branchId: string,
        sessionId: string,
        input: { columnMappings?: ImportColumnMapping[]; importOptions?: Partial<ImportMappingState["importOptions"]> }
    ) {
        await this.authorize(userId, branchId);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: { rows: { orderBy: { rowNumber: "asc" }, select: { rawData: true } } },
        });
        if (!session) throw new Error("Import session not found");

        const columns = Object.keys((session.rows[0]?.rawData ?? {}) as Record<string, unknown>);
        const current = normalizeMapping(session.mapping, columns);
        const next: ImportMappingState = {
            ...current,
            columnMappings: input.columnMappings ?? current.columnMappings,
            importOptions: {
                ...(current.importOptions ?? {}),
                ...(input.importOptions ?? {}),
                paymentMapping: {
                    ...(current.importOptions?.paymentMapping ?? {
                        paidValues: [],
                        unpaidValues: [],
                        waivedValues: [],
                        unclearValues: [],
                        confirmed: false,
                    }),
                    ...(input.importOptions?.paymentMapping ?? {}),
                },
            },
        };

        if (next.importOptions?.paymentAction === "IMPORT_PAID_UNPAID" && !next.importOptions.paymentMapping?.confirmed) {
            const inferredPaymentMapping = inferConfirmedPaymentMapping({
                current: next.importOptions.paymentMapping,
                columnMappings: next.columnMappings,
                rows: session.rows,
            });
            if (inferredPaymentMapping) {
                next.importOptions = {
                    ...next.importOptions,
                    paymentMapping: inferredPaymentMapping,
                };
            }
        }

        await prisma.importSession.update({
            where: { id: sessionId },
            data: { mapping: asJson(next) },
        });

        return this.revalidateSession(userId, branchId, sessionId);
    }

    static async updateRows(
        userId: string,
        branchId: string,
        sessionId: string,
        input: {
            edits?: { rowId: string; rawData?: Record<string, string>; normalizedData?: ImportNormalizedRow }[];
            skipRowIds?: string[];
            unskipRowIds?: string[];
        }
    ) {
        await this.authorize(userId, branchId);
        const session = await prisma.importSession.findFirst({ where: { id: sessionId, branchId } });
        if (!session) throw new Error("Import session not found");

        for (const edit of input.edits ?? []) {
            const existingRow = edit.normalizedData
                ? await prisma.importRow.findFirst({
                    where: { id: edit.rowId, importSessionId: sessionId },
                    select: { mappedData: true },
                })
                : null;

            await prisma.importRow.updateMany({
                where: { id: edit.rowId, importSessionId: sessionId },
                data: {
                    ...(edit.rawData ? {
                        rawData: asJson(edit.rawData),
                        mappedData: asJson({}),
                        normalizedData: asJson({}),
                        issues: asJson([]),
                        warnings: asJson([]),
                        confidence: null,
                        status: "NEEDS_REVIEW" as ImportRowStatus,
                    } : {}),
                    ...(edit.normalizedData ? {
                        normalizedData: asJson(edit.normalizedData),
                        mappedData: asJson(markManualNormalizedData(existingRow?.mappedData ?? {})),
                        issues: asJson([]),
                        warnings: asJson([]),
                        confidence: 100,
                        skipped: false,
                        status: "NEEDS_REVIEW" as ImportRowStatus,
                    } : {}),
                },
            });
        }

        if (input.skipRowIds?.length) {
            await prisma.importRow.updateMany({
                where: { id: { in: input.skipRowIds }, importSessionId: sessionId },
                data: { skipped: true, status: "SKIPPED" },
            });
        }

        if (input.unskipRowIds?.length) {
            await prisma.importRow.updateMany({
                where: { id: { in: input.unskipRowIds }, importSessionId: sessionId },
                data: { skipped: false },
            });
        }

        return this.revalidateSession(userId, branchId, sessionId);
    }

    static async revalidateSession(userId: string, branchId: string, sessionId: string) {
        await this.authorize(userId, branchId);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: { rows: { orderBy: { rowNumber: "asc" } } },
        });
        if (!session) throw new Error("Import session not found");

        const columns = Object.keys((session.rows[0]?.rawData ?? {}) as Record<string, unknown>);
        const mapping = normalizeMapping(session.mapping, columns);
        const sourceProfile = sourceProfileFromSession(session, columns);
        const context = await this.getValidationContext(branchId);
        const normalizedRows = session.rows.map(row => {
            if (
                hasManualNormalizedData(row.mappedData) &&
                row.normalizedData &&
                typeof row.normalizedData === "object" &&
                !Array.isArray(row.normalizedData) &&
                Object.keys(row.normalizedData as Record<string, unknown>).length > 0
            ) {
                const defaulted = applyImportDefaults(row.normalizedData as ImportNormalizedRow, mapping.importOptions);
                const promoted = promoteKnownMultiShiftAllocation(defaulted, context);
                const normalizedData = applyImportDefaults(promoted, mapping.importOptions, context);
                return {
                    row,
                    mappedData: row.mappedData ?? {},
                    normalizedData,
                    normalizationIssues: [] as ImportIssue[],
                    confidence: row.confidence,
                };
            }

            const normalized = normalizeImportRow(
                row.rawData as Record<string, string>,
                mapping.columnMappings,
                mapping.importOptions?.paymentMapping
            );
            const defaulted = applyImportDefaults(normalized.normalizedData, mapping.importOptions);
            const promoted = promoteKnownMultiShiftAllocation(defaulted, context);
            const normalizedData = applyImportDefaults(promoted, mapping.importOptions, context);
            return {
                row,
                mappedData: normalized.mappedData,
                normalizedData,
                normalizationIssues: normalized.issues,
                confidence: normalized.confidence,
            };
        });

        const duplicateMap = detectDuplicateImportRows(normalizedRows.map(item => ({
            id: item.row.id,
            rowNumber: item.row.rowNumber,
            normalizedData: item.normalizedData,
        })));
        const stagedRows = normalizedRows.map(item => ({
            id: item.row.id,
            rowNumber: item.row.rowNumber,
            status: item.row.status,
            skipped: item.row.skipped,
            normalizedData: item.normalizedData,
        }));

        const questionDrafts: { rowId?: string; field?: string; question: string; options?: unknown }[] = [
            ...(mapping.questions ?? []).map(question => ({
                field: question.field,
                question: question.question,
                options: question.options,
            })),
        ];

        const processedRows = normalizedRows.map(item => {
            if (["IMPORTED", "FAILED"].includes(item.row.status)) {
                return {
                    row: item.row,
                    mappedData: item.mappedData,
                    normalizedData: item.normalizedData,
                    issues: Array.isArray(item.row.issues) ? item.row.issues as ImportIssue[] : [],
                    warnings: Array.isArray(item.row.warnings) ? item.row.warnings as ImportIssue[] : [],
                    confidence: item.confidence,
                    status: item.row.status,
                    questions: [],
                };
            }

            const baseIssues = item.normalizationIssues;
            const result = mergeValidatorResults(
                { issues: baseIssues, warnings: [], questions: [] },
                validateRequiredImportFields(item.normalizedData),
                validateImportStudent(item.normalizedData, context),
                validateImportSeat(item.normalizedData, {
                    seatsByLabel: context.seatsByLabel,
                    createUnknownSeats: mapping.importOptions?.createUnknownSeats,
                    skipUnknownSeatAllocations: mapping.importOptions?.skipUnknownSeatAllocations,
                }),
                validateImportShift(item.normalizedData, {
                    shiftsByName: context.shiftsByName,
                    multiShiftsByName: context.multiShiftsByName,
                    createUnknownShifts: mapping.importOptions?.createUnknownShifts,
                    createUnknownMultiShifts: mapping.importOptions?.createUnknownMultiShifts,
                    skipUnknownShiftAllocations: mapping.importOptions?.skipUnknownShiftAllocations,
                    skipUnknownMultiShiftAllocations: mapping.importOptions?.skipUnknownMultiShiftAllocations,
                    skipMissingShiftAllocations: mapping.importOptions?.skipMissingShiftAllocations,
                }),
                validateImportAllocation(item.normalizedData, {
                    ...context,
                    skipConflictingAllocations: mapping.importOptions?.skipConflictingAllocations,
                }),
                validateImportPayment(item.normalizedData, mapping)
            );

            const duplicateWarnings = [
                ...(duplicateMap.get(item.row.id) ?? []),
                ...detectExistingStudentDuplicates(item.normalizedData, context.existingStudents),
            ];
            const stagedConflicts = findStagedAllocationConflicts({
                rowId: item.row.id,
                normalizedData: item.normalizedData,
                rows: stagedRows,
                context,
            });
            const skippedStagedConflicts = mapping.importOptions?.skipConflictingAllocations
                ? stagedAllocationConflictWarnings(stagedConflicts)
                : [];
            const issues = [
                ...result.issues,
                ...(mapping.importOptions?.skipConflictingAllocations ? [] : stagedConflicts),
            ];
            const warnings = [...result.warnings, ...skippedStagedConflicts, ...duplicateWarnings];
            const status = statusForValidation({
                skipped: item.row.skipped,
                issues,
                warnings,
            });

            return {
                row: item.row,
                mappedData: item.mappedData,
                normalizedData: item.normalizedData,
                issues,
                warnings,
                confidence: item.confidence,
                status,
                questions: result.questions,
            };
        });

        questionDrafts.push(...processedRows.flatMap(row => row.questions));

        const rowUpdateChunkSize = 100;
        for (let index = 0; index < processedRows.length; index += rowUpdateChunkSize) {
            const chunk = processedRows.slice(index, index + rowUpdateChunkSize);
            await Promise.all(chunk.map(item =>
                prisma.importRow.update({
                    where: { id: item.row.id },
                    data: {
                        mappedData: asJson(item.mappedData),
                        normalizedData: asJson(item.normalizedData),
                        issues: asJson(item.issues),
                        warnings: asJson(item.warnings),
                        confidence: item.confidence,
                        status: item.status,
                    },
                })
            ));
        }

        await prisma.importQuestion.deleteMany({
            where: { importSessionId: sessionId, status: "OPEN" },
        });

        const uniqueQuestions = dedupeImportQuestionDrafts(questionDrafts);

        if (uniqueQuestions.length > 0) {
            await prisma.importQuestion.createMany({
                data: uniqueQuestions.map(question => ({
                    importSessionId: sessionId,
                    rowId: question.rowId,
                    field: question.field,
                    question: question.question,
                    options: asJson(question.options ?? null),
                })),
            });
        }

        const rows = await prisma.importRow.findMany({ where: { importSessionId: sessionId } });
        const questions = await prisma.importQuestion.findMany({ where: { importSessionId: sessionId } });
        const openQuestions = questions.filter(question => question.status === "OPEN").length;
        const hasReviewBlocking = rows.some(row => ["NEEDS_REVIEW", "DUPLICATE"].includes(row.status));
        const status: ImportSessionStatus =
            openQuestions > 0 ? "NEEDS_INFO" :
            hasReviewBlocking ? "VALIDATED" :
            rows.some(row => row.status === "READY" || row.status === "WARNING") ? "READY_TO_COMMIT" :
            "NEEDS_MAPPING";
        const attention = buildImportAttention({ rows, questions, mapping });
        const detectedPaymentValues = Array.from(new Set(processedRows
            .map(row => row.normalizedData.payment?.rawStatus)
            .filter((value): value is string => Boolean(value))));
        const nextMapping: ImportMappingState = {
            ...mapping,
            analysis: buildImportSessionAnalysis({
                sourceProfile,
                attention,
                mapping,
                sessionStatus: status,
                model: mapping.analysis?.model,
                notes: mapping.analysis?.notes,
                ai: mapping.analysis?.ai,
                detectedPaymentValues,
            }),
        };
        const summary = {
            ...summarizeRows(rows, {
                mapping: nextMapping,
                sourceProfile,
                openQuestions,
            }),
            attention,
        };

        await prisma.importSession.update({
            where: { id: sessionId },
            data: {
                status,
                mapping: asJson(nextMapping),
                summary: asJson(summary),
            },
        });

        return this.getSessionDetail(userId, branchId, sessionId);
    }
}
