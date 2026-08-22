import type {
    ImportGoal,
    ImportReadinessPolicy,
    PaymentMethod,
    ImportRowStatus,
    ImportRunItemKind,
    ImportRunKind,
    ImportRunStatus,
} from "@/app/generated/prisma/enums";
import type {
    ImportIssue,
    ImportMappingState,
    ImportNormalizedRow,
    ImportSessionSummary,
} from "./import-session.contract";

export type {
    ImportGoal,
    ImportReadinessPolicy,
    ImportRunItemKind,
    ImportRunItemStatus,
    ImportRunKind,
    ImportRunStatus,
} from "@/app/generated/prisma/enums";

export const IMPORT_ENGINE_VERSION = 2;
export const IMPORT_PLAN_SCHEMA_VERSION = 2;

export type ImportRowEvaluationInput = {
    rowId: string;
    rowNumber: number;
    status: ImportRowStatus;
    mappedData?: unknown;
    normalizedData?: ImportNormalizedRow | null;
    issues?: ImportIssue[];
    warnings?: ImportIssue[];
    confidence?: number | null;
    skipped?: boolean;
};

export type PublishImportEvaluationsInput = {
    userId: string;
    branchId: string;
    sessionId: string;
    targetRevision: number;
    evaluations: ImportRowEvaluationInput[];
};

export type ImportPlanCheck = {
    code: "READY_ROWS" | "OPEN_QUESTIONS" | "ALL_ROWS_READY" | "EVALUATION_COVERAGE" | "CONFIGURATION_APPROVAL" | "CONFIGURATION_CONFLICT" | "MUTATION_LIMIT" | "RETRY_DEPENDENCY" | "RETRY_MUTATION_CONFLICT";
    status: "pass" | "block";
    count?: number;
    message: string;
};

export type ImportPlanSnapshotItem = {
    evaluationId: string;
    rowId: string;
    rowNumber: number;
    status: ImportRowStatus;
    skipped: boolean;
};

export type ImportPlanMutationItem = {
    itemKey: string;
    kind: ImportRunItemKind;
    evaluationId?: string | null;
    rowId?: string | null;
    payload?: Record<string, unknown> | null;
};

export type ImportPreviouslySucceededMutation = {
    itemKey: string;
    kind: ImportRunItemKind;
    rowId?: string | null;
    entityIds: string[];
    requestHash: string;
};

export type ImportPlanSnapshot = {
    schemaVersion: typeof IMPORT_PLAN_SCHEMA_VERSION;
    sessionId: string;
    targetRevision: number;
    engineVersion: typeof IMPORT_ENGINE_VERSION;
    goal: ImportGoal;
    readinessPolicy: ImportReadinessPolicy;
    mapping: ImportMappingState;
    summary: ImportSessionSummary | null;
    evaluations: ImportPlanSnapshotItem[];
    items: ImportPlanMutationItem[];
    requiredPermissions: string[];
    configurationApproval: {
        required: boolean;
        approved: boolean;
        affectedRows: number;
    };
    mutationSummary: ImportMutationSummary;
};

export type ImportMutationSummary = {
    total: number;
    configuration: number;
    students: number;
    allocations: number;
    paymentCycles: number;
    affectedRows: {
        students: number;
        allocations: number;
        payments: number;
        configuration: number;
    };
    payments: {
        historical: { DUE: number; PAID: number; WAIVED: number };
        current: { DUE: number; PAID: number; WAIVED: number };
    };
    paymentBreakdown: Array<{
        rowId: string;
        rowNumber: number;
        studentName: string;
        historical: { DUE: number; PAID: number; WAIVED: number };
        current: { DUE: number; PAID: number; WAIVED: number };
        total: number;
    }>;
};

export type ImportPlanPaymentCycleDetail = {
    itemKey: string;
    rowId: string;
    rowNumber: number;
    studentName: string;
    bucket: "historical" | "current";
    periodStart: string;
    periodEnd: string;
    dueDate: string;
    amount: number;
    status: "DUE" | "PAID" | "WAIVED";
    method?: PaymentMethod;
    referenceId?: string;
};

export type CompiledImportPlan = {
    planVersion: string;
    canRun: boolean;
    totalRows: number;
    readyRows: number;
    blockedRows: number;
    warningRows: number;
    skippedRows: number;
    checks: ImportPlanCheck[];
    snapshot: ImportPlanSnapshot;
    summary: {
        totalRows: number;
        readyRows: number;
        blockedRows: number;
        warningRows: number;
        skippedRows: number;
        mutations: ImportMutationSummary;
        requiredPermissions: string[];
    };
};

export type CompileImportPlanInput = {
    userId: string;
    branchId: string;
    sessionId: string;
    targetRevision: number;
    readinessPolicy: ImportReadinessPolicy;
};

export type CreateImportRunInput = {
    userId: string;
    branchId: string;
    sessionId: string;
    kind: ImportRunKind;
    importPlanId?: string;
    confirmedPlanVersion?: string;
    targetRevision: number;
    idempotencyKey: string;
    maxAttempts?: number;
};

export type AttachImportWorkflowRunInput = {
    importRunId: string;
    workflowRunId: string;
};

export type ClaimImportRunBatchInput = {
    importRunId: string;
    workerId: string;
    limit?: number;
    leaseMilliseconds?: number;
    now?: Date;
};

export type ClaimedImportRunItem = {
    id: string;
    importRunId: string;
    importRowId: string | null;
    evaluationId: string | null;
    ordinal: number;
    itemKey: string;
    kind: ImportRunItemKind;
    idempotencyKey: string;
    requestHash: string;
    leaseToken: string;
    attemptCount: number;
    rowNumber: number | null;
    payload: Record<string, unknown> | null;
    mappedData: unknown;
    normalizedData: ImportNormalizedRow | null;
    issues: ImportIssue[];
    warnings: ImportIssue[];
};

export type CompleteImportRunItemInput = {
    importRunId: string;
    itemId: string;
    leaseToken: string;
    result?: ImportRunItemResult;
    now?: Date;
};

export type FailImportRunItemInput = {
    importRunId: string;
    itemId: string;
    leaseToken: string;
    error: {
        code: string;
        message: string;
        retryable: boolean;
    };
    retryDelayMilliseconds?: number;
    now?: Date;
};

export type HeartbeatImportRunItemInput = {
    importRunId: string;
    itemId: string;
    leaseToken: string;
    leaseMilliseconds?: number;
    now?: Date;
};

export type ImportRunProgress = {
    status: ImportRunStatus;
    totalItems: number;
    completedItems: number;
    succeededItems: number;
    failedItems: number;
    skippedItems: number;
    cancelledItems: number;
};

export type ImportRunItemResult = {
    entityIds?: string[];
    counts?: Record<string, number>;
};

export type ImportRecipeInput = {
    name: string;
    goal: ImportGoal;
    sourceType: "CSV" | "XLSX" | "XLS" | "PDF" | "PASTED_TABLE" | "OTHER";
    normalizedHeaderSignature: string;
    entityTypes: ImportMappingState["entityTypesDetected"];
    columnMappings: ImportMappingState["columnMappings"];
};
