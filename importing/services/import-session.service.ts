import { prisma } from "@/lib/prisma";
import { sortSeatsByLabel } from "@/lib/seatNumbering";
import { EntitlementService } from "@/services/entitlement.service";
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
import { applyImportGoalMappingPolicy, applyImportGoalPolicy } from "@/importing/utils/import-goal-policy";
import { importStagingPurgeAfter } from "@/importing/utils/import-retention";
import { isImportRunDispatchRequired } from "@/importing/utils/import-run-dispatch";
import { createImportAnalysisRunIdentity } from "@/importing/utils/import-run-identity";
import { ImportParserError, ImportRevisionConflictError, ImportValidationError } from "@/importing/utils/import-errors";
import type { Prisma } from "@/app/generated/prisma/client";
import type { ImportRowStatus, ImportSessionStatus } from "@/app/generated/prisma/enums";
import {
    MAX_IMPORT_ROWS,
    importRowLimitMessage,
} from "@/importing/constants/import-limits";

export { MAX_IMPORT_ROWS } from "@/importing/constants/import-limits";

export type ImportSessionRowFilter = "attention" | "ready" | "all" | "skipped";

export type ImportBulkRowAction = {
    action: "SKIP" | "UNSKIP";
    issueCode: string;
};

export type ImportSessionDetailOptions = {
    rowFilter?: ImportSessionRowFilter;
    issueCode?: string;
    limit?: number;
    cursor?: number;
};

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function retainedEntityIds(value: Prisma.JsonValue | null) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entityIds = (value as { entityIds?: unknown }).entityIds;
    return Array.isArray(entityIds)
        ? entityIds.filter((id): id is string => typeof id === "string" && Boolean(id))
        : [];
}

function retainedCreatedEntityId(value: Prisma.JsonValue | null, key: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" && candidate ? candidate : undefined;
}

function retainedCreatedEntityIds(value: Prisma.JsonValue | null, key: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = (value as Record<string, unknown>)[key];
    return Array.isArray(candidate)
        ? candidate.filter((id): id is string => typeof id === "string" && Boolean(id))
        : [];
}

function toStringDate(value: Date) {
    return value.toISOString();
}

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Something went wrong";
}

function terminalImportSessionStatus(status: string) {
    return ["COMMITTING", "COMMITTED", "PARTIAL", "FAILED", "CANCELLED"].includes(status);
}

function importSessionIsEditable(engineVersion: number, status: string) {
    if (engineVersion === 1 && terminalImportSessionStatus(status)) return false;
    return !["COMMITTING", "COMMITTED", "CANCELLED"].includes(status);
}

function expectedImportRevision(value: number) {
    if (!Number.isInteger(value) || value < 0) {
        throw new ImportValidationError("Expected import revision must be a non-negative integer");
    }
    return value;
}

function importIssueCodeMatches(value: Prisma.JsonValue | null, issueCode: string) {
    return Array.isArray(value) && value.some(issue =>
        issue
        && typeof issue === "object"
        && !Array.isArray(issue)
        && "code" in issue
        && issue.code === issueCode
    );
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

export function rowWhereForFilter(
    importSessionId: string,
    filter: ImportSessionRowFilter = "all",
    cursor?: number,
    issueCode?: string
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
    if (issueCode) {
        const matchingIssue = asJson([{ code: issueCode }]);
        where.AND = [{
            OR: [
                { issues: { array_contains: matchingIssue } },
                { warnings: { array_contains: matchingIssue } },
            ],
        }];
    }

    return where;
}

function normalizeIssueCodeFilter(value: string | undefined) {
    if (value === undefined) return undefined;
    const issueCode = value.trim();
    if (!issueCode || issueCode.length > 100 || !/^[A-Z0-9_:-]+$/.test(issueCode)) {
        throw new ImportValidationError("Import row issue filter is invalid");
    }
    return issueCode;
}

async function parseImportSource(input: CreateImportSessionInput): Promise<ParsedImportSource> {
    if (input.sourceType === "PASTED_TABLE") return parsePastedTable(input.pastedTable);
    if (input.sourceType === "CSV") return parseCsv(input.fileBuffer);
    if (input.sourceType === "XLSX" || input.sourceType === "XLS") {
        return parseXlsx(input.fileBuffer, {
            sheetName: input.sourceConfiguration?.sheetName,
            headerRow: input.sourceConfiguration?.headerRow,
            expectedFormat: input.sourceType,
        });
    }
    if (input.sourceType === "PDF") return parsePdf(input.fileBuffer);
    throw new Error("Choose a CSV, XLSX, XLS, or PDF file.");
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
            // Successful rows are immutable during a partial-repair revision.
            // Their retained diagnostic JSON is historical evidence, not an
            // unresolved action for the operator.
            rows: input.rows.filter(row => row.status !== "IMPORTED"),
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
    const sortedSeats = sortSeatsByLabel(branch.seats);

    return {
        defaultFee: branch.defaultFee ?? 0,
        defaultAdmissionFee: branch.defaultAdmissionFee ?? 0,
        seats: sortedSeats,
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
        throw new Error(importRowLimitMessage(rowCount));
    }
}

export class ImportSessionService {
    private static async authorize(userId: string, branchId: string) {
        await StaffService.authorize(userId, branchId, "students");
    }

    private static async authorizeMutation(userId: string, branchId: string) {
        await this.authorize(userId, branchId);
        await EntitlementService.assertBranchWritable(branchId);
    }

    static async getSessionEngineVersion(userId: string, branchId: string, sessionId: string) {
        await this.authorize(userId, branchId);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId, archivedAt: null },
            select: { engineVersion: true },
        });
        if (!session) throw new Error("Import session not found");
        return session.engineVersion;
    }

    static async getAnalysisStartState(userId: string, branchId: string, sessionId: string) {
        await this.authorize(userId, branchId);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId, archivedAt: null },
            select: {
                engineVersion: true,
                draftRevision: true,
                sourceType: true,
                sourceConfiguration: true,
            },
        });
        if (!session) throw new Error("Import session not found");
        return session;
    }

    static async createSession(userId: string, branchId: string, input: CreateImportSessionInput) {
        await this.authorizeMutation(userId, branchId);
        const parsed = await parseImportSource(input);
        if (
            !Array.isArray(parsed.rowNumbers)
            || parsed.rowNumbers.length !== parsed.rows.length
            || parsed.rowNumbers.some((rowNumber, index) => (
                !Number.isInteger(rowNumber)
                || rowNumber < 1
                || (index > 0 && rowNumber <= parsed.rowNumbers[index - 1])
            ))
        ) {
            throw new ImportParserError("Import parser returned invalid source row positions.");
        }
        assertImportRowLimit(parsed.rows.length);
        const sourceProfile = buildImportSourceProfile(parsed);
        const goal = input.goal ?? "STUDENTS";
        const now = new Date();

        const persisted = await prisma.$transaction(async tx => {
            await StaffService.authorize(userId, branchId, "students", tx);
            await EntitlementService.assertBranchWritable(branchId, tx);
            const created = await tx.importSession.create({
                data: {
                    branchId,
                    uploadedByUserId: userId,
                    sourceType: input.sourceType,
                    engineVersion: 2,
                    goal,
                    purgeAfter: importStagingPurgeAfter(now),
                    fileName: input.fileName,
                    sourceConfiguration: asJson({
                        sourceType: input.sourceType,
                        ...(input.sourceConfiguration ?? {}),
                        parser: parsed.parserMetadata ?? null,
                    }),
                    fileMeta: asJson({
                        ...(input.fileMeta ?? {}),
                        columns: parsed.columns,
                        rowCount: parsed.rows.length,
                        sourceProfile,
                        parser: parsed.parserMetadata ?? null,
                    }),
                    summary: asJson({ ...emptySummary(), totalRows: parsed.rows.length, sourceProfile }),
                },
            });

            const chunkSize = 500;
            for (let index = 0; index < parsed.rows.length; index += chunkSize) {
                await tx.importRow.createMany({
                    data: parsed.rows.slice(index, index + chunkSize).map((row, offset) => ({
                        importSessionId: created.id,
                        branchId,
                        rowNumber: parsed.rowNumbers[index + offset],
                        rawData: asJson(row),
                    })),
                });
            }

            const analysisIdentity = createImportAnalysisRunIdentity({
                branchId,
                sessionId: created.id,
                targetRevision: 0,
            });
            const analysisRun = await tx.importRun.create({
                data: {
                    branchId,
                    importSessionId: created.id,
                    targetRevision: 0,
                    requestedByUserId: userId,
                    idempotencyKey: analysisIdentity.idempotencyKey,
                    requestHash: analysisIdentity.requestHash,
                    kind: "ANALYSIS",
                    status: input.sourceType === "PDF" ? "WAITING_FOR_USER" : "QUEUED",
                    totalItems: 0,
                },
            });

            return { session: created, analysisRun };
        });

        return {
            id: persisted.session.id,
            rowCount: parsed.rows.length,
            columns: parsed.columns,
            status: persisted.session.status,
            sourceConfiguration: persisted.session.sourceConfiguration,
            analysisRun: persisted.analysisRun,
            extractionPreview: input.sourceType === "PDF" ? parsed.rows.slice(0, 5) : undefined,
        };
    }

    static async listSessions(userId: string, branchId: string) {
        await this.authorize(userId, branchId);
        const sessions = await prisma.importSession.findMany({
            where: { branchId, archivedAt: null },
            orderBy: { createdAt: "desc" },
            take: 30,
        });

        return sessions.map(session => ({
            id: session.id,
            branchId: session.branchId,
            sourceType: session.sourceType,
            fileName: session.fileName,
            status: session.status,
            engineVersion: session.engineVersion,
            goal: session.goal,
            draftRevision: session.draftRevision,
            activeEvaluationRevision: session.activeEvaluationRevision,
            archivedAt: session.archivedAt ? toStringDate(session.archivedAt) : null,
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
        if (session.archivedAt) throw new Error("Import session is archived");
        const latestRun = await prisma.importRun.findFirst({
            where: { importSessionId: session.id, branchId },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                kind: true,
                status: true,
                totalItems: true,
                completedItems: true,
                succeededItems: true,
                failedItems: true,
                skippedItems: true,
                cancelledItems: true,
                workflowRunId: true,
                lastHeartbeatAt: true,
                startedAt: true,
                finishedAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        const latestRunPublic = latestRun
            ? {
                id: latestRun.id,
                kind: latestRun.kind,
                status: latestRun.status,
                totalItems: latestRun.totalItems,
                completedItems: latestRun.completedItems,
                succeededItems: latestRun.succeededItems,
                failedItems: latestRun.failedItems,
                skippedItems: latestRun.skippedItems,
                cancelledItems: latestRun.cancelledItems,
                startedAt: latestRun.startedAt,
                finishedAt: latestRun.finishedAt,
                createdAt: latestRun.createdAt,
                workflowAttached: Boolean(latestRun.workflowRunId),
                dispatchRequired: isImportRunDispatchRequired(latestRun),
            }
            : null;
        const extractionPreview = session.sourceType === "PDF" && latestRun?.status === "WAITING_FOR_USER"
            ? await prisma.importRow.findMany({
                where: { importSessionId: session.id },
                orderBy: { rowNumber: "asc" },
                take: 5,
                select: { rowNumber: true, rawData: true },
            })
            : [];
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
        const issueCode = normalizeIssueCodeFilter(options.issueCode);
        const limit = clampRowLimit(options.limit);
        const rowsWhere = rowWhereForFilter(sessionId, filter, options.cursor, issueCode);
        const pageRows = await prisma.importRow.findMany({
            where: rowsWhere,
            orderBy: { rowNumber: "asc" },
            ...(limit ? { take: limit + 1 } : {}),
        });
        const hasMore = Boolean(limit && pageRows.length > limit);
        const returnedRows = hasMore && limit ? pageRows.slice(0, limit) : pageRows;
        const filteredRows = options.rowFilter || issueCode || limit || options.cursor
            ? await prisma.importRow.count({ where: rowWhereForFilter(sessionId, filter, undefined, issueCode) })
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
                issueCode: issueCode ?? null,
                limit: limit ?? null,
                cursor: options.cursor ? String(options.cursor) : null,
                nextCursor,
                hasMore,
                totalRows: summaryRows.length,
                filteredRows,
                returnedRows: returnedRows.length,
            },
            branchContext,
            latestRun: latestRunPublic,
            extractionPreview,
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
        const sortedSeats = sortSeatsByLabel(branch.seats);
        const activeAllocations = await prisma.seatAllocation.findMany({
            where: { endDate: null, seat: { branchId } },
            include: { seat: { select: { label: true } }, shift: { select: { name: true, startTime: true, endTime: true } } },
        });

        return {
            branchDefaultFee: branch.defaultFee ?? 0,
            defaultAdmissionFee: branch.defaultAdmissionFee ?? 0,
            seatsByLabel: new Map(sortedSeats.map(seat => [seat.label.toLowerCase(), seat])),
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
                seats: sortedSeats.map(seat => seat.label),
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

    static async analyzeSession(
        userId: string,
        branchId: string,
        sessionId: string,
        targetRevision?: number
    ) {
        await this.authorizeMutation(userId, branchId);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: { rows: { orderBy: { rowNumber: "asc" } } },
        });
        if (!session) throw new Error("Import session not found");
        if (session.archivedAt) throw new Error("Import session is archived");
        if (terminalImportSessionStatus(session.status)) {
            return this.getSessionDetail(userId, branchId, sessionId);
        }
        const analysisBaseRevision = expectedImportRevision(targetRevision ?? session.draftRevision);
        if (session.draftRevision < analysisBaseRevision) throw new ImportRevisionConflictError();
        if (
            session.draftRevision > analysisBaseRevision
            || (
                session.mapping
                && session.activeEvaluationRevision === session.draftRevision
            )
        ) {
            return session.activeEvaluationRevision === session.draftRevision
                ? this.getSessionDetail(userId, branchId, sessionId)
                : this.revalidateAuthorizedSession(userId, branchId, sessionId);
        }

        const claimed = await prisma.importSession.updateMany({
            where: {
                id: sessionId,
                branchId,
                draftRevision: analysisBaseRevision,
                archivedAt: null,
                status: { notIn: ["COMMITTING", "COMMITTED", "PARTIAL", "FAILED", "CANCELLED"] },
            },
            data: { status: "ANALYZING", purgeAfter: importStagingPurgeAfter() },
        });
        if (claimed.count !== 1) throw new ImportRevisionConflictError();

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

            const mapping = applyImportGoalMappingPolicy(session.goal, {
                ...aiMapping,
                importOptions: applyImportGoalPolicy(session.goal, aiMapping.suggestedImportOptions),
                analysis: buildImportSessionAnalysis({
                    sourceProfile,
                    attention: [],
                    model: aiMapping.model,
                    notes: aiMapping.analysisNotes,
                    ai: aiMapping.aiTrace,
                }),
            });

            const publishedMapping = await prisma.$transaction(async tx => {
                await tx.$queryRaw<Array<{ id: string }>>`
                    SELECT "id" FROM "ImportSession"
                    WHERE "id" = ${sessionId} AND "branchId" = ${branchId}
                    FOR UPDATE
                `;
                const current = await tx.importSession.findFirst({
                    where: { id: sessionId, branchId },
                    select: {
                        draftRevision: true,
                        archivedAt: true,
                        status: true,
                    },
                });
                if (!current) throw new Error("Import session not found");
                if (current.archivedAt) throw new Error("Import session is archived");
                if (current.draftRevision > analysisBaseRevision) return false;
                if (current.draftRevision !== analysisBaseRevision) throw new ImportRevisionConflictError();
                if (["COMMITTING", "COMMITTED", "PARTIAL", "FAILED", "CANCELLED"].includes(current.status)) {
                    throw new Error("Import session is not editable");
                }
                await tx.importSession.update({
                    where: { id: sessionId },
                    data: {
                        mapping: asJson(mapping),
                        draftRevision: { increment: 1 },
                        purgeAfter: importStagingPurgeAfter(),
                    },
                });
                return true;
            });

            if (!publishedMapping) throw new ImportRevisionConflictError();
            return this.revalidateAuthorizedSession(userId, branchId, sessionId);
        } catch (error) {
            await prisma.importSession.updateMany({
                where: {
                    id: sessionId,
                    branchId,
                    draftRevision: analysisBaseRevision,
                    status: "ANALYZING",
                },
                data: {
                    status: "NEEDS_MAPPING",
                    summary: asJson({
                        ...emptySummary(),
                        warnings: [getErrorMessage(error)],
                    }),
                    purgeAfter: importStagingPurgeAfter(),
                },
            });
            throw error;
        }
    }

    static async updateMapping(
        userId: string,
        branchId: string,
        sessionId: string,
        input: {
            expectedRevision: number;
            columnMappings?: ImportColumnMapping[];
            importOptions?: Partial<ImportMappingState["importOptions"]>;
        }
    ) {
        await this.authorizeMutation(userId, branchId);
        const expectedRevision = expectedImportRevision(input.expectedRevision);
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: { rows: { orderBy: { rowNumber: "asc" }, select: { rawData: true } } },
        });
        if (!session) throw new Error("Import session not found");
        if (session.archivedAt) throw new Error("Import session is archived");
        if (!importSessionIsEditable(session.engineVersion, session.status)) throw new Error("Import session is not editable");
        if (session.draftRevision !== expectedRevision) throw new ImportRevisionConflictError();

        const columns = Object.keys((session.rows[0]?.rawData ?? {}) as Record<string, unknown>);
        const current = normalizeMapping(session.mapping, columns);
        if (input.columnMappings) {
            const reviewedSources = new Set(input.columnMappings.map(mapping => mapping.sourceColumn));
            if (
                input.columnMappings.length !== columns.length
                || reviewedSources.size !== columns.length
                || columns.some(column => !reviewedSources.has(column))
            ) {
                throw new ImportValidationError(
                    "Every positional source column must be mapped or intentionally ignored."
                );
            }
        }
        const next = applyImportGoalMappingPolicy(session.goal, {
            ...current,
            columnMappings: input.columnMappings ?? current.columnMappings,
            importOptions: applyImportGoalPolicy(session.goal, {
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
            }),
        });

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

        await prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportSession"
                WHERE "id" = ${sessionId} AND "branchId" = ${branchId}
                FOR UPDATE
            `;
            const current = await tx.importSession.findFirst({
                where: { id: sessionId, branchId },
                select: {
                    engineVersion: true,
                    status: true,
                    draftRevision: true,
                    archivedAt: true,
                },
            });
            if (!current) throw new Error("Import session not found");
            if (current.archivedAt) throw new Error("Import session is archived");
            await StaffService.authorize(userId, branchId, "students", tx);
            await EntitlementService.assertBranchWritable(branchId, tx);
            if (!importSessionIsEditable(current.engineVersion, current.status)) {
                throw new Error("Import session is not editable");
            }
            if (current.draftRevision !== expectedRevision) throw new ImportRevisionConflictError();
            await tx.importSession.update({
                where: { id: sessionId },
                data: {
                    mapping: asJson(next),
                    draftRevision: { increment: 1 },
                    purgeAfter: importStagingPurgeAfter(),
                },
            });
        });

        return this.revalidateAuthorizedSession(userId, branchId, sessionId);
    }

    static async updateRows(
        userId: string,
        branchId: string,
        sessionId: string,
        input: {
            expectedRevision: number;
            edits?: { rowId: string; rawData?: Record<string, string>; normalizedData?: ImportNormalizedRow }[];
            skipRowIds?: string[];
            unskipRowIds?: string[];
            bulkAction?: ImportBulkRowAction;
        }
    ) {
        await this.authorizeMutation(userId, branchId);
        const expectedRevision = expectedImportRevision(input.expectedRevision);
        const hasExplicitRowAction = input.edits !== undefined
            || input.skipRowIds !== undefined
            || input.unskipRowIds !== undefined;
        if (input.bulkAction && hasExplicitRowAction) {
            throw new ImportValidationError("Bulk row action cannot be combined with explicit row changes");
        }
        const issueCode = input.bulkAction?.issueCode.trim();
        if (
            input.bulkAction
            && (
                !issueCode
                || issueCode.length > 100
                || !/^[A-Z0-9_:-]+$/.test(issueCode)
            )
        ) {
            throw new ImportValidationError("Bulk row action issue code is invalid");
        }
        const edits = input.edits ?? [];
        let skipRowIds = input.skipRowIds ?? [];
        let unskipRowIds = input.unskipRowIds ?? [];
        const editedIds = edits.map(edit => edit.rowId);
        if (new Set(editedIds).size !== editedIds.length) throw new Error("Each import row can be edited only once per request");
        const skipIds = new Set(skipRowIds);
        if (unskipRowIds.some(rowId => skipIds.has(rowId))) {
            throw new Error("An import row cannot be skipped and unskipped in the same request");
        }
        let targetRowIds = [...new Set([...editedIds, ...skipRowIds, ...unskipRowIds])];
        if (targetRowIds.length > MAX_IMPORT_ROWS) {
            throw new ImportValidationError(`An import row action can target at most ${MAX_IMPORT_ROWS} rows`);
        }

        await prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportSession"
                WHERE "id" = ${sessionId} AND "branchId" = ${branchId}
                FOR UPDATE
            `;
            await StaffService.authorize(userId, branchId, "students", tx);
            await EntitlementService.assertBranchWritable(branchId, tx);
            const session = await tx.importSession.findFirst({
                where: { id: sessionId, branchId },
                select: {
                    engineVersion: true,
                    status: true,
                    draftRevision: true,
                    archivedAt: true,
                },
            });
            if (!session) throw new Error("Import session not found");
            if (session.archivedAt) throw new Error("Import session is archived");
            if (!importSessionIsEditable(session.engineVersion, session.status)) {
                throw new Error("Import session is not editable");
            }
            if (session.draftRevision !== expectedRevision) throw new ImportRevisionConflictError();

            if (input.bulkAction && issueCode) {
                const unresolvedRows = await tx.importRow.findMany({
                    where: {
                        importSessionId: sessionId,
                        status: { not: "IMPORTED" },
                    },
                    orderBy: { rowNumber: "asc" },
                    take: MAX_IMPORT_ROWS + 1,
                    select: {
                        id: true,
                        status: true,
                        skipped: true,
                        issues: true,
                        warnings: true,
                    },
                });
                if (unresolvedRows.length > MAX_IMPORT_ROWS) {
                    throw new ImportValidationError(`An import row action can target at most ${MAX_IMPORT_ROWS} rows`);
                }
                const matchingRows = unresolvedRows.filter(row =>
                    importIssueCodeMatches(row.issues, issueCode)
                    || importIssueCodeMatches(row.warnings, issueCode)
                );
                if (input.bulkAction.action === "SKIP") {
                    skipRowIds = matchingRows.filter(row => !row.skipped).map(row => row.id);
                    unskipRowIds = [];
                } else {
                    skipRowIds = [];
                    unskipRowIds = matchingRows.filter(row => row.skipped || row.status === "SKIPPED").map(row => row.id);
                }
                targetRowIds = [...new Set([...skipRowIds, ...unskipRowIds])];
            }

            const targetRows = targetRowIds.length > 0
                ? await tx.importRow.findMany({
                    where: { id: { in: targetRowIds }, importSessionId: sessionId },
                    select: { id: true, status: true, mappedData: true },
                })
                : [];
            if (targetRows.length !== targetRowIds.length) throw new Error("Import row not found");
            if (targetRows.some(row => row.status === "IMPORTED")) {
                throw new Error("Imported rows are immutable; edit an unresolved row instead");
            }
            const targetRowsById = new Map(targetRows.map(row => [row.id, row]));

            for (const edit of edits) {
                const existingRow = targetRowsById.get(edit.rowId)!;
                await tx.importRow.update({
                    where: { id: edit.rowId },
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
                            mappedData: asJson(markManualNormalizedData(existingRow.mappedData ?? {})),
                            issues: asJson([]),
                            warnings: asJson([]),
                            confidence: 100,
                            skipped: false,
                            status: "NEEDS_REVIEW" as ImportRowStatus,
                        } : {}),
                    },
                });
            }
            if (skipRowIds.length > 0) {
                await tx.importRow.updateMany({
                    where: { id: { in: skipRowIds }, importSessionId: sessionId },
                    data: { skipped: true, status: "SKIPPED" },
                });
            }
            if (unskipRowIds.length > 0) {
                await tx.importRow.updateMany({
                    where: { id: { in: unskipRowIds }, importSessionId: sessionId },
                    data: { skipped: false },
                });
            }

            await tx.importSession.update({
                where: { id: sessionId },
                data: {
                    ...(targetRowIds.length > 0 ? { draftRevision: { increment: 1 } } : {}),
                    purgeAfter: importStagingPurgeAfter(),
                },
            });
        }, { timeout: 30_000 });

        return this.revalidateAuthorizedSession(userId, branchId, sessionId);
    }

    static async revalidateSession(userId: string, branchId: string, sessionId: string) {
        await this.authorizeMutation(userId, branchId);
        const bumped = await prisma.importSession.updateMany({
            where: {
                id: sessionId,
                branchId,
                archivedAt: null,
                engineVersion: 2,
                status: { notIn: ["COMMITTING", "COMMITTED", "CANCELLED"] },
            },
            data: {
                draftRevision: { increment: 1 },
                purgeAfter: importStagingPurgeAfter(),
            },
        });
        if (bumped.count !== 1) throw new Error("Import session not found");
        return this.revalidateAuthorizedSession(userId, branchId, sessionId);
    }

    static async revalidateCurrentDraft(userId: string, branchId: string, sessionId: string) {
        await this.authorizeMutation(userId, branchId);
        return this.revalidateAuthorizedSession(userId, branchId, sessionId);
    }

    private static async revalidateAuthorizedSession(userId: string, branchId: string, sessionId: string) {
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: { rows: { orderBy: { rowNumber: "asc" } } },
        });
        if (!session) throw new Error("Import session not found");
        if (session.archivedAt) throw new Error("Import session is archived");
        if (session.engineVersion === 2 && session.activeEvaluationRevision === session.draftRevision) {
            return this.getSessionDetail(userId, branchId, sessionId);
        }

        const succeededRowItems = session.engineVersion === 2
            ? await prisma.importRunItem.findMany({
                where: {
                    importRowId: { in: session.rows.map(row => row.id) },
                    status: "SUCCEEDED",
                    run: { importSessionId: sessionId, kind: "COMMIT" },
                },
                orderBy: { createdAt: "desc" },
                select: {
                    importRowId: true,
                    kind: true,
                    result: true,
                },
            })
            : [];
        const succeededStudentIdByRow = new Map<string, string>();
        const allocationSucceededRowIds = new Set<string>();
        for (const item of succeededRowItems) {
            if (!item.importRowId) continue;
            if (item.kind === "STUDENT" && !succeededStudentIdByRow.has(item.importRowId)) {
                const studentId = retainedEntityIds(item.result)[0];
                if (studentId) succeededStudentIdByRow.set(item.importRowId, studentId);
            }
            if (item.kind === "ALLOCATION") allocationSucceededRowIds.add(item.importRowId);
        }
        for (const row of session.rows) {
            const studentId = retainedCreatedEntityId(row.createdEntityIds, "studentId");
            if (studentId && !succeededStudentIdByRow.has(row.id)) {
                succeededStudentIdByRow.set(row.id, studentId);
            }
            if (retainedCreatedEntityIds(row.createdEntityIds, "allocationIds").length > 0) {
                allocationSucceededRowIds.add(row.id);
            }
        }

        const columns = Object.keys((session.rows[0]?.rawData ?? {}) as Record<string, unknown>);
        const mapping = normalizeMapping(session.mapping, columns);
        const sourceProfile = sourceProfileFromSession(session, columns);
        const context = await this.getValidationContext(branchId);
        const normalizedRows = session.rows.map(row => {
            if (row.status === "IMPORTED") {
                return {
                    row,
                    mappedData: row.mappedData ?? {},
                    normalizedData: (row.normalizedData ?? {}) as ImportNormalizedRow,
                    normalizationIssues: [] as ImportIssue[],
                    confidence: row.confidence,
                };
            }
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
                    succeededStudentId: succeededStudentIdByRow.get(row.id),
                    allocationAlreadySucceeded: allocationSucceededRowIds.has(row.id),
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
                succeededStudentId: succeededStudentIdByRow.get(row.id),
                allocationAlreadySucceeded: allocationSucceededRowIds.has(row.id),
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
                ...(item.allocationAlreadySucceeded ? [] : [
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
                ]),
                validateImportPayment(item.normalizedData, mapping)
            );

            const duplicateWarnings = [
                ...(duplicateMap.get(item.row.id) ?? []),
                ...detectExistingStudentDuplicates(
                    item.normalizedData,
                    item.succeededStudentId
                        ? context.existingStudents.filter(student => student.id !== item.succeededStudentId)
                        : context.existingStudents
                ),
            ];
            const stagedConflicts = item.allocationAlreadySucceeded
                ? []
                : findStagedAllocationConflicts({
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
        const uniqueQuestions = dedupeImportQuestionDrafts(questionDrafts);
        const detectedPaymentValues = Array.from(new Set(processedRows
            .map(row => row.normalizedData.payment?.rawStatus)
            .filter((value): value is string => Boolean(value))));
        await prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportSession"
                WHERE "id" = ${sessionId} AND "branchId" = ${branchId}
                FOR UPDATE
            `;
            const currentSession = await tx.importSession.findFirst({
                where: { id: sessionId, branchId },
                select: { draftRevision: true, archivedAt: true },
            });
            if (!currentSession) throw new Error("Import session not found");
            if (currentSession.archivedAt) throw new Error("Import session is archived");
            if (currentSession.draftRevision !== session.draftRevision) {
                throw new ImportRevisionConflictError();
            }

            const mutableProcessedRows = processedRows.filter(item => item.row.status !== "IMPORTED");
            const rowUpdateChunkSize = 100;
            for (let index = 0; index < mutableProcessedRows.length; index += rowUpdateChunkSize) {
                const chunk = mutableProcessedRows.slice(index, index + rowUpdateChunkSize);
                await Promise.all(chunk.map(item =>
                    tx.importRow.update({
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

            await tx.importQuestion.deleteMany({
                where: { importSessionId: sessionId, status: "OPEN" },
            });
            if (uniqueQuestions.length > 0) {
                await tx.importQuestion.createMany({
                    data: uniqueQuestions.map(question => ({
                        importSessionId: sessionId,
                        rowId: question.rowId,
                        field: question.field,
                        question: question.question,
                        options: asJson(question.options ?? null),
                    })),
                });
            }

            const rows = await tx.importRow.findMany({ where: { importSessionId: sessionId } });
            const questions = await tx.importQuestion.findMany({ where: { importSessionId: sessionId } });
            const openQuestions = questions.filter(question => question.status === "OPEN").length;
            const hasReviewBlocking = rows.some(row => ["NEEDS_REVIEW", "DUPLICATE"].includes(row.status));
            const status: ImportSessionStatus =
                openQuestions > 0 ? "NEEDS_INFO" :
                hasReviewBlocking ? "VALIDATED" :
                rows.some(row => row.status === "READY" || row.status === "WARNING") ? "READY_TO_COMMIT" :
                "NEEDS_MAPPING";
            const unresolvedRows = rows.filter(row => row.status !== "IMPORTED");
            const attention = buildImportAttention({ rows: unresolvedRows, questions, mapping });
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
            if (session.engineVersion === 2) {
                await tx.importRowEvaluation.createMany({
                    data: rows.map(row => ({
                        importRowId: row.id,
                        branchId: session.branchId,
                        revision: session.draftRevision,
                        engineVersion: 2,
                        status: row.status,
                        mappedData: row.mappedData === null ? undefined : asJson(row.mappedData),
                        normalizedData: row.normalizedData === null ? undefined : asJson(row.normalizedData),
                        issues: asJson(Array.isArray(row.issues) ? row.issues : []),
                        warnings: asJson(Array.isArray(row.warnings) ? row.warnings : []),
                        confidence: row.confidence,
                        skipped: row.skipped,
                    })),
                });
            }
            const updated = await tx.importSession.updateMany({
                where: { id: sessionId, branchId, draftRevision: session.draftRevision },
                data: {
                    status,
                    mapping: asJson(nextMapping),
                    summary: asJson(summary),
                    ...(session.engineVersion === 2 ? { activeEvaluationRevision: session.draftRevision } : {}),
                    purgeAfter: importStagingPurgeAfter(),
                },
            });
            if (updated.count !== 1) {
                throw new ImportRevisionConflictError();
            }
        }, { timeout: 30_000 });

        return this.getSessionDetail(userId, branchId, sessionId);
    }
}
