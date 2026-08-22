import { apiClient } from "./core";
import type {
    ImportColumnMapping,
    ImportEntityType,
    ImportGoal,
    ImportNormalizedRow,
    ImportOptions,
    ImportTargetField,
} from "@/importing/contracts/import-session.contract";
import type {
    ImportMutationSummary,
    ImportPlanPaymentCycleDetail,
    ImportReadinessPolicy,
    ImportRunItemKind,
    ImportRunItemStatus,
    ImportRunKind,
    ImportRunStatus,
} from "@/importing/contracts/import-v2.contract";

type DetailOptions = {
    rowFilter?: "attention" | "ready" | "all" | "skipped";
    issueCode?: string | null;
    limit?: number;
    cursor?: string | number | null;
};

export type CreateImportSessionResponse = {
    sessionId: string;
    runId: string | null;
    status: string;
    requiresPdfConfirmation?: boolean;
    extractionPreview?: Array<Record<string, unknown> | unknown[]>;
    dispatchPending?: boolean;
    workflowAttached?: boolean;
    dispatchRequired?: boolean;
    /** Temporary compatibility with the V1 creation response. */
    id?: string;
};

export type CreateImportFileOptions = {
    sheetName?: string;
    /** One-based worksheet row number. */
    headerRow?: number;
    pdfConfirmed?: boolean;
};

export type WorkbookHeaderCandidate = {
    rowNumber: number;
    values: string[];
    filledCells: number;
};

export type WorkbookSheetCandidate = {
    name: string;
    index: number;
    populatedRows: number;
    columnCount: number;
    suggestedHeaderRow: number | null;
    headerCandidates: WorkbookHeaderCandidate[];
};

export type WorkbookSelectionDetails = {
    format?: "XLSX" | "XLS";
    sheets: WorkbookSheetCandidate[];
};

export type ImportPlanResponse = {
    id: string;
    revision: number;
    readinessPolicy: ImportReadinessPolicy;
    planVersion: string;
    canRun: boolean;
    totalRows: number;
    readyRows: number;
    blockedRows: number;
    warningRows: number;
    skippedRows: number;
    checks: Array<{
        code: string;
        status: "pass" | "block";
        count?: number;
        message: string;
    }>;
    summary?: {
        totalRows: number;
        readyRows: number;
        blockedRows: number;
        warningRows: number;
        skippedRows: number;
        mutations: ImportMutationSummary;
        requiredPermissions: string[];
    };
    mutationSummary?: ImportMutationSummary;
    paymentDetails?: {
        totalCycles: number;
        affectedStudents: number;
        maxPageSize: number;
    };
    requiredPermissions?: string[];
    configurationApproval?: {
        required: boolean;
        approved: boolean;
        affectedRows: number;
    };
    snapshot?: {
        evaluations?: Array<{ rowId: string; rowNumber: number; status: string; skipped: boolean }>;
        items?: Array<{ rowId?: string | null; kind: ImportRunItemKind }>;
    };
    createdAt?: string;
};

export type ImportPlanPaymentDetailsResponse = {
    planId: string;
    revision: number;
    planVersion: string;
    totalCycles: number;
    affectedStudents: number;
    cycles: ImportPlanPaymentCycleDetail[];
    page: {
        limit: number;
        cursor: string | null;
        nextCursor: string | null;
        hasMore: boolean;
        returnedCycles: number;
    };
};

export type ImportRunItem = {
    id: string;
    ordinal: number;
    itemKey: string;
    kind: ImportRunItemKind;
    status: ImportRunItemStatus;
    attemptCount: number;
    result: { counts?: Record<string, number> } | null;
    error: { code?: string; message?: string; retryable?: boolean } | null;
    startedAt: string | null;
    finishedAt: string | null;
};

export type ImportRun = {
    id: string;
    importSessionId?: string | null;
    importPlanId?: string | null;
    targetRevision?: number;
    kind: ImportRunKind;
    status: ImportRunStatus;
    totalItems: number;
    completedItems: number;
    succeededItems: number;
    failedItems: number;
    skippedItems: number;
    cancelledItems: number;
    error?: { code?: string; message?: string; retryable?: boolean } | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
    updatedAt?: string;
    items?: ImportRunItem[];
    dispatchPending?: boolean;
    workflowAttached?: boolean;
    dispatchRequired?: boolean;
};

export type ImportRunStartResponse = {
    runId: string;
    status: ImportRunStatus;
    dispatchPending?: boolean;
    workflowAttached?: boolean;
    dispatchRequired?: boolean;
};

export type ImportRecipe = {
    id: string;
    name: string;
    revision: number;
    goal: ImportGoal;
    sourceType: "CSV" | "XLSX" | "XLS" | "PDF" | "PASTED_TABLE" | "OTHER";
    sourceFingerprint: string;
    sourceColumns: string[];
    entityTypes: ImportEntityType[];
    columnMappings: Array<{ sourceColumn: string; targetField: ImportTargetField }>;
    useCount: number;
    lastUsedAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type CreateImportRecipeInput = {
    name: string;
    goal: ImportGoal;
    sourceType: ImportRecipe["sourceType"];
    sourceColumns: string[];
    entityTypes: ImportEntityType[];
    columnMappings: Array<{ sourceColumn: string; targetField: ImportTargetField }>;
};

type LegacyCreateImportSessionResponse = {
    id: string;
    sessionId?: string;
    runId?: string | null;
    status: string;
};

type RevisionedMappingUpdate = {
    expectedRevision: number;
    columnMappings?: ImportColumnMapping[];
    importOptions?: Partial<ImportOptions>;
};

type RevisionedRowUpdate = {
    expectedRevision: number;
    edits?: unknown[];
    skipRowIds?: string[];
    unskipRowIds?: string[];
    bulkAction?: {
        action: "SKIP" | "UNSKIP";
        issueCode: string;
    };
};

type RevisionedQuestionAnswer = {
    expectedRevision: number;
    questionId: string;
    answer: unknown;
    applyToAffectedRows?: boolean;
};

const revisionConflictMessage = "This import changed in another tab or by a newer action. Refresh the session, review the latest version, and retry your edit.";

export class ImportSessionApiError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly details: Record<string, unknown>;

    constructor(message: string, options: { status: number; code?: string; details?: Record<string, unknown> }) {
        super(message);
        this.name = "ImportSessionApiError";
        this.status = options.status;
        this.code = options.code;
        this.details = options.details ?? {};
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function parseResponse<T>(response: Response): Promise<T> {
    const rawData: unknown = await response.json().catch(() => ({}));
    const data = asRecord(rawData);
    if (!response.ok) {
        const message = response.status === 409
            ? revisionConflictMessage
            : typeof data.error === "string" ? data.error : "Import request failed";
        throw new ImportSessionApiError(message, {
            status: response.status,
            code: typeof data.code === "string" ? data.code : undefined,
            details: data,
        });
    }
    return rawData as T;
}

async function requestJson<T>(
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    headers: Record<string, string> = {}
): Promise<T> {
    return fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
    }).then(response => parseResponse<T>(response));
}

function normalizeCreatedSession(response: CreateImportSessionResponse | LegacyCreateImportSessionResponse): CreateImportSessionResponse {
    const sessionId = response.sessionId ?? response.id;
    if (!sessionId) throw new Error("Import session was created without a session identifier. Refresh the import list and try again.");
    return {
        ...response,
        sessionId,
        runId: response.runId ?? null,
        status: response.status,
    };
}

function normalizeRunStart(response: ImportRunStartResponse | (Partial<ImportRun> & { id?: string; runId?: string })): ImportRunStartResponse {
    const runId = response.runId ?? ("id" in response ? response.id : undefined);
    if (!runId || !response.status) throw new Error("Import run started without a run identifier. Refresh the session and try again.");
    return {
        runId,
        status: response.status,
        ...(response.dispatchPending !== undefined ? { dispatchPending: response.dispatchPending } : {}),
        ...(response.workflowAttached !== undefined ? { workflowAttached: response.workflowAttached } : {}),
        ...(response.dispatchRequired !== undefined ? { dispatchRequired: response.dispatchRequired } : {}),
    };
}

export const importSessions = {
    list(branchId: string): Promise<unknown> {
        return apiClient.get<unknown, unknown>(`/branches/${branchId}/import-sessions`);
    },

    createFromFile(
        branchId: string,
        file: File,
        goal: ImportGoal,
        options: CreateImportFileOptions = {}
    ): Promise<CreateImportSessionResponse> {
        const form = new FormData();
        form.append("file", file);
        form.append("goal", goal);
        if (options.sheetName) form.append("sheetName", options.sheetName);
        if (options.headerRow) form.append("headerRow", String(options.headerRow));
        if (options.pdfConfirmed !== undefined) form.append("pdfConfirmed", String(options.pdfConfirmed));
        return fetch(`/api/branches/${branchId}/import-sessions`, {
            method: "POST",
            body: form,
        })
            .then(response => parseResponse<CreateImportSessionResponse | LegacyCreateImportSessionResponse>(response))
            .then(normalizeCreatedSession);
    },

    createFromPastedTable(branchId: string, pastedTable: string, goal: ImportGoal): Promise<CreateImportSessionResponse> {
        return requestJson<CreateImportSessionResponse | LegacyCreateImportSessionResponse>(
            `/api/branches/${branchId}/import-sessions`,
            "POST",
            { pastedTable, fileName: "Pasted table", goal }
        ).then(normalizeCreatedSession);
    },

    detail<T = unknown>(branchId: string, sessionId: string, options: DetailOptions = {}): Promise<T> {
        const params = new URLSearchParams();
        if (options.rowFilter) params.set("rowFilter", options.rowFilter);
        if (options.issueCode) params.set("issueCode", options.issueCode);
        if (options.limit) params.set("limit", String(options.limit));
        if (options.cursor) params.set("cursor", String(options.cursor));
        const query = params.toString();
        return apiClient.get<unknown, T>(`/branches/${branchId}/import-sessions/${sessionId}${query ? `?${query}` : ""}`);
    },

    analyze<T = unknown>(branchId: string, sessionId: string, options: { confirmPdfExtraction?: boolean } = {}): Promise<T> {
        return requestJson<T>(`/api/branches/${branchId}/import-sessions/${sessionId}/analyze`, "POST", options);
    },

    updateMapping<T = unknown>(branchId: string, sessionId: string, data: RevisionedMappingUpdate): Promise<T> {
        return requestJson<T>(`/api/branches/${branchId}/import-sessions/${sessionId}/mapping`, "PATCH", data);
    },

    updateRows<T = unknown>(branchId: string, sessionId: string, data: RevisionedRowUpdate): Promise<T> {
        return requestJson<T>(`/api/branches/${branchId}/import-sessions/${sessionId}/rows`, "PATCH", data);
    },

    previewRow<T = unknown>(branchId: string, sessionId: string, data: { rowId: string; normalizedData: ImportNormalizedRow }): Promise<T> {
        return apiClient.post<unknown, T>(`/branches/${branchId}/import-sessions/${sessionId}/rows/preview`, data);
    },

    availability<T = unknown>(branchId: string, sessionId: string, data: { rowId: string; shiftIds?: string[]; multiShiftId?: string | null }): Promise<T> {
        return apiClient.post<unknown, T>(`/branches/${branchId}/import-sessions/${sessionId}/availability`, data);
    },

    answerQuestion<T = unknown>(branchId: string, sessionId: string, data: RevisionedQuestionAnswer): Promise<T> {
        return requestJson<T>(`/api/branches/${branchId}/import-sessions/${sessionId}/questions`, "POST", data);
    },

    createPlan(
        branchId: string,
        sessionId: string,
        readinessPolicy: ImportReadinessPolicy,
        targetRevision: number
    ): Promise<ImportPlanResponse> {
        return requestJson<ImportPlanResponse>(
            `/api/branches/${branchId}/import-sessions/${sessionId}/plans`,
            "POST",
            { readinessPolicy, targetRevision }
        );
    },

    getPlanPayments(
        branchId: string,
        sessionId: string,
        planId: string,
        options: { limit?: number; cursor?: string | null } = {}
    ): Promise<ImportPlanPaymentDetailsResponse> {
        const params = new URLSearchParams();
        if (options.limit) params.set("limit", String(options.limit));
        if (options.cursor) params.set("cursor", options.cursor);
        const query = params.toString();
        return fetch(`/api/branches/${branchId}/import-sessions/${sessionId}/plans/${planId}/payments${query ? `?${query}` : ""}`)
            .then(response => parseResponse<ImportPlanPaymentDetailsResponse>(response));
    },

    commitPlan(branchId: string, sessionId: string, planId: string, idempotencyKey: string): Promise<ImportRunStartResponse> {
        return requestJson<ImportRunStartResponse | (Partial<ImportRun> & { id?: string; runId?: string })>(
            `/api/branches/${branchId}/import-sessions/${sessionId}/commit`,
            "POST",
            { planId, confirmed: true },
            { "Idempotency-Key": idempotencyKey }
        ).then(normalizeRunStart);
    },

    getRun(branchId: string, runId: string): Promise<ImportRun> {
        return fetch(`/api/branches/${branchId}/import-runs/${runId}`)
            .then(response => parseResponse<ImportRun>(response));
    },

    resumeRun(branchId: string, runId: string): Promise<ImportRunStartResponse> {
        return requestJson<ImportRunStartResponse>(`/api/branches/${branchId}/import-runs/${runId}/resume`, "POST", {});
    },

    cancelRun(branchId: string, runId: string): Promise<ImportRunStartResponse> {
        return requestJson<ImportRunStartResponse>(`/api/branches/${branchId}/import-runs/${runId}/cancel`, "POST", {});
    },

    retryRun(branchId: string, runId: string, planId: string, idempotencyKey: string): Promise<ImportRunStartResponse> {
        return requestJson<ImportRunStartResponse | (Partial<ImportRun> & { id?: string; runId?: string })>(
            `/api/branches/${branchId}/import-runs/${runId}/retry`,
            "POST",
            { planId, confirmed: true },
            { "Idempotency-Key": idempotencyKey }
        ).then(normalizeRunStart);
    },

    exportRunErrors(branchId: string, runId: string, format: "csv" | "xlsx" = "csv"): Promise<Blob> {
        return fetch(`/api/branches/${branchId}/import-runs/${runId}/errors?format=${format}`).then(async response => {
            if (!response.ok) await parseResponse<never>(response);
            return response.blob();
        });
    },

    listRecipes(branchId: string): Promise<ImportRecipe[]> {
        return fetch(`/api/branches/${branchId}/import-recipes`)
            .then(response => parseResponse<ImportRecipe[]>(response));
    },

    createRecipe(branchId: string, input: CreateImportRecipeInput): Promise<ImportRecipe> {
        return requestJson<ImportRecipe>(`/api/branches/${branchId}/import-recipes`, "POST", input);
    },
};
