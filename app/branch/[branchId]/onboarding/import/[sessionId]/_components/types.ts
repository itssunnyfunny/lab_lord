import type {
    ImportAttentionBucket,
    ImportBranchContext,
    ImportColumnMapping,
    ImportIssue,
    ImportNormalizedRow,
    ImportOptions,
    ImportPipelineStep,
    ImportSourceProfile,
} from "@/importing/contracts/import-session.contract";
import type { ImportRowDraftPreview } from "@/importing/contracts/import-preview.contract";
import type { ImportPlanResponse, ImportRecipe, ImportRun } from "@/lib/api/importSessions";
import type { ImportRowDraft } from "@/importing/utils/manual-row-draft";

export type RowFilter = "attention" | "ready" | "all" | "skipped";
export type ImportGoal = "STUDENTS" | "STUDENTS_ALLOCATIONS" | "FULL";

export type ImportRow = {
    id: string;
    rowNumber: number;
    rawData: Record<string, string>;
    mappedData: Record<string, unknown> | null;
    normalizedData: ImportNormalizedRow | null;
    status: string;
    issues: ImportIssue[];
    warnings: ImportIssue[];
    confidence: number | null;
    skipped: boolean;
};

export type ImportQuestion = {
    id: string;
    rowId: string | null;
    field: string | null;
    question: string;
    options: string[] | null;
    answer?: unknown;
    status: string;
};

export type ImportDetail = {
    id: string;
    status: string;
    goal?: ImportGoal | null;
    sourceType?: ImportRecipe["sourceType"];
    sourceConfiguration?: {
        pdfConfirmed?: boolean;
        sheetName?: string;
        headerRow?: number;
        [key: string]: unknown;
    } | null;
    extractionPreview?: Array<{
        rowNumber: number;
        rawData: Record<string, unknown>;
    }>;
    draftRevision: number;
    activeEvaluationRevision: number | null;
    fileName?: string | null;
    fileMeta?: {
        parser?: {
            headers?: Array<{
                index: number;
                original: string;
                column: string;
                wasBlank: boolean;
                duplicateOf?: string;
            }>;
        } | null;
    } | null;
    updatedAt?: string;
    mapping?: {
        entityTypesDetected?: string[];
        columnMappings?: ImportColumnMapping[];
        importOptions?: ImportOptions;
        warnings?: string[];
        usedFallback?: boolean;
        analysis?: {
            sourceProfile?: ImportSourceProfile;
            attention?: ImportAttentionBucket[];
            pipeline?: ImportPipelineStep[];
            model?: string;
            notes?: string[];
            detectedPaymentValues?: string[];
            ai?: {
                status: "success" | "fallback" | "unavailable" | "invalid_response" | "error";
                model?: string;
                attemptedAt: string;
                durationMs: number;
                fallbackReason?: string;
                error?: string;
                usedStructuredOutput?: boolean;
            };
        };
    } | null;
    summary?: {
        totalRows: number;
        readyRows: number;
        needsReviewRows: number;
        blockedRows: number;
        warningRows: number;
        duplicateRows: number;
        conflictRows: number;
        skippedRows: number;
        readinessScore: number;
        openQuestions?: number;
        detectedEntityCounts: Record<string, number>;
        attention?: ImportAttentionBucket[];
        sourceProfile?: ImportSourceProfile;
    } | null;
    rows: ImportRow[];
    rowPage?: {
        filter: RowFilter;
        issueCode?: string | null;
        limit: number | null;
        cursor: string | null;
        nextCursor: string | null;
        hasMore: boolean;
        totalRows: number;
        filteredRows: number;
        returnedRows: number;
    };
    branchContext?: ImportBranchContext;
    questions: ImportQuestion[];
    commits?: { status: string; summary: Record<string, number>; errors?: unknown; createdAt?: string }[];
    latestRun?: ImportRun | null;
};

export type PaymentDraft = {
    paid: string;
    unpaid: string;
    waived: string;
    defaultMethod: string;
};

export type RowDraft = ImportRowDraft;
export type RowPreview = ImportRowDraftPreview;
export type Plan = ImportPlanResponse;
export type Run = ImportRun;
