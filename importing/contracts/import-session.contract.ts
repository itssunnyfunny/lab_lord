import type {
    ImportCommitStatus,
    ImportGoal,
    ImportQuestionStatus,
    ImportRowStatus,
    ImportSessionStatus,
    ImportSourceType,
    PaymentMethod,
    PaymentStatus,
} from "@/app/generated/prisma/enums";

export type { ImportGoal } from "@/app/generated/prisma/enums";

export const IMPORT_TARGET_FIELDS = [
    "student.name",
    "student.phone",
    "student.joinedAt",
    "student.monthlyFee",
    "student.feeSource",
    "student.feeLinkedShiftName",
    "student.feeLinkedMultiShiftName",
    "seat.label",
    "shift.name",
    "shift.startTime",
    "shift.endTime",
    "multiShift.name",
    "multiShift.componentShiftNames",
    "allocation.seatLabel",
    "allocation.shiftName",
    "allocation.multiShiftName",
    "payment.amount",
    "payment.status",
    "payment.method",
    "payment.referenceId",
    "ignore",
] as const;

export type ImportTargetField = typeof IMPORT_TARGET_FIELDS[number];

export type ImportEntityType = "STUDENT" | "SEAT" | "SHIFT" | "ALLOCATION" | "PAYMENT";

export type ParsedImportRow = Record<string, string>;

export type ParsedImportSource = {
    columns: string[];
    rows: ParsedImportRow[];
    /** One-based physical source row for each entry in `rows`, in the same order. */
    rowNumbers: number[];
    parserMetadata?: Record<string, unknown>;
};

export type ImportColumnMapping = {
    sourceColumn: string;
    targetField: ImportTargetField;
    confidence: number;
    reason?: string;
    source?: "AI" | "DETERMINISTIC" | "MANUAL";
    autoApplied?: boolean;
    needsReview?: boolean;
};

export type ImportAIQuestion = {
    field?: string;
    question: string;
    options?: string[];
};

export type ImportDetectedColumnKind =
    | "name"
    | "phone"
    | "date"
    | "money"
    | "paymentStatus"
    | "paymentMethod"
    | "seat"
    | "shift"
    | "time"
    | "text"
    | "empty";

export type ImportColumnProfile = {
    column: string;
    filledRows: number;
    emptyRows: number;
    fillRate: number;
    uniqueValueCount: number;
    sampleValues: string[];
    detectedKind: ImportDetectedColumnKind;
};

export type ImportSourceProfile = {
    rowCount: number;
    columnCount: number;
    emptyCellRate: number;
    columns: ImportColumnProfile[];
    highSignalColumns: string[];
    lowSignalColumns: string[];
};

export type ImportAttentionBucket = {
    code: string;
    label: string;
    severity: "error" | "warning" | "info";
    count: number;
    message: string;
    action?: string;
    fields?: string[];
    sampleRowNumbers?: number[];
};

export type ImportPipelineStep = {
    id: "extract" | "profile" | "ai_mapping" | "validate" | "review" | "commit";
    label: string;
    status: "pending" | "running" | "completed" | "needs_attention" | "failed";
    detail?: string;
};

export type ImportAITrace = {
    status: "success" | "fallback" | "unavailable" | "invalid_response" | "error";
    model?: string;
    attemptedAt: string;
    durationMs: number;
    fallbackReason?: string;
    error?: string;
    usedStructuredOutput?: boolean;
};

export type ImportSessionAnalysis = {
    generatedAt: string;
    sourceProfile: ImportSourceProfile;
    attention: ImportAttentionBucket[];
    pipeline: ImportPipelineStep[];
    model?: string;
    notes?: string[];
    ai?: ImportAITrace;
    detectedPaymentValues?: string[];
};

export type ImportMappingResult = {
    entityTypesDetected: ImportEntityType[];
    columnMappings: ImportColumnMapping[];
    questions: ImportAIQuestion[];
    warnings: string[];
    suggestedImportOptions?: Partial<ImportOptions>;
    analysisNotes?: string[];
    model?: string;
    usedFallback?: boolean;
    aiTrace?: ImportAITrace;
};

export type PaymentCycleOption = "USE_JOINED_AT_ANNIVERSARY" | "SKIP_PAYMENTS";

export type PaymentImportAction =
    | "GENERATE_DUE"
    | "IMPORT_PAID_UNPAID"
    | "SKIP_PAYMENTS";

export type PaymentHistoryMode =
    | "START_CURRENT_JOINED_CYCLE"
    | "FROM_JOINED_MARK_PAID"
    | "FROM_JOINED_MARK_DUE"
    | "FROM_JOINED_PAID_THROUGH_PREVIOUS";

export type ImportPaymentMapping = {
    paidValues: string[];
    unpaidValues: string[];
    waivedValues: string[];
    unclearValues: string[];
    confirmed: boolean;
    defaultMethod?: PaymentMethod;
};

export type ImportOptions = {
    paymentCycle?: PaymentCycleOption;
    paymentAction?: PaymentImportAction;
    paymentHistoryMode?: PaymentHistoryMode;
    paymentMapping?: ImportPaymentMapping;
    defaultJoinedAt?: string;
    defaultSeatLabel?: string;
    defaultShiftName?: string;
    defaultMultiShiftName?: string;
    createUnknownSeats?: boolean;
    createUnknownShifts?: boolean;
    createUnknownMultiShifts?: boolean;
    /** One explicit batch approval for every missing seat/shift/bundle in this reviewed revision. */
    configurationBatchApproved?: boolean;
    skipUnknownSeatAllocations?: boolean;
    skipUnknownShiftAllocations?: boolean;
    skipUnknownMultiShiftAllocations?: boolean;
    skipMissingShiftAllocations?: boolean;
    skipConflictingAllocations?: boolean;
};

export type ImportBranchContext = {
    defaultFee: number;
    defaultAdmissionFee: number;
    seats: {
        id: string;
        label: string;
    }[];
    shifts: {
        id: string;
        name: string;
        startTime: string | null;
        endTime: string | null;
        price: number;
    }[];
    multiShifts: {
        id: string;
        name: string;
        price: number;
        componentShiftNames: string[];
    }[];
};

export type ImportMappingState = {
    entityTypesDetected: ImportEntityType[];
    columnMappings: ImportColumnMapping[];
    questions?: ImportAIQuestion[];
    warnings?: string[];
    importOptions?: ImportOptions;
    analysis?: ImportSessionAnalysis;
    usedFallback?: boolean;
};

export type ImportIssue = {
    code: string;
    field?: string;
    message: string;
    severity: "error" | "warning" | "info";
};

export type ImportNormalizedRow = {
    student?: {
        name?: string;
        phone?: string;
        joinedAt?: string;
        joinedAtSource?: "UPLOADED" | "OPERATOR_DEFAULT" | "TODAY_DEFAULT";
        monthlyFee?: number;
        feeSource?: "UPLOADED" | "BRANCH_DEFAULT" | "SHIFT_PRICE" | "MULTI_SHIFT_PRICE";
        feeLinkedShiftName?: string;
        feeLinkedMultiShiftName?: string;
    };
    seat?: {
        label?: string;
    };
    shift?: {
        name?: string;
        startTime?: string;
        endTime?: string;
    };
    multiShift?: {
        name?: string;
        componentShiftNames?: string[];
    };
    allocation?: {
        seatLabel?: string;
        shiftName?: string;
        multiShiftName?: string;
    };
    payment?: {
        amount?: number;
        status?: PaymentStatus | "UNCLEAR";
        rawStatus?: string;
        method?: PaymentMethod;
        referenceId?: string;
    };
};

export type ImportSessionSummary = {
    totalRows: number;
    readyRows: number;
    needsReviewRows: number;
    blockedRows: number;
    warningRows: number;
    duplicateRows: number;
    conflictRows: number;
    skippedRows: number;
    readinessScore: number;
    detectedEntityCounts: Record<ImportEntityType, number>;
    warnings: string[];
    openQuestions?: number;
    attention?: ImportAttentionBucket[];
    sourceProfile?: ImportSourceProfile;
};

export type CreateImportSessionInput =
    | {
          sourceType: Extract<ImportSourceType, "CSV" | "XLSX" | "XLS" | "PDF" | "OTHER">;
          fileName?: string;
          fileMeta?: Record<string, unknown>;
          fileBuffer: Buffer;
          goal?: ImportGoal;
          sourceConfiguration?: {
              sheetName?: string;
              headerRow?: number;
              pdfConfirmed?: boolean;
          };
      }
    | {
          sourceType: "PASTED_TABLE";
          fileName?: string;
          fileMeta?: Record<string, unknown>;
          pastedTable: string;
          goal?: ImportGoal;
          sourceConfiguration?: Record<string, never>;
      };

/** @deprecated Use ImportReadinessPolicy for V2 plans. */
export type CommitMode = "SAFE_PARTIAL" | "STRICT_ALL_OR_NOTHING";

export type ImportSessionListItem = {
    id: string;
    branchId: string;
    sourceType: ImportSourceType;
    fileName: string | null;
    status: ImportSessionStatus;
    engineVersion: number;
    goal: ImportGoal | null;
    draftRevision: number;
    activeEvaluationRevision: number | null;
    archivedAt: string | null;
    summary: ImportSessionSummary | null;
    createdAt: string;
    updatedAt: string;
};

export type ImportCommitResult = {
    status: ImportCommitStatus;
    summary: Record<string, number>;
    errors: { rowId?: string; rowNumber?: number; message: string }[];
};

export type ImportQuestionDto = {
    id: string;
    rowId: string | null;
    field: string | null;
    question: string;
    options: unknown;
    answer: unknown;
    status: ImportQuestionStatus;
    createdAt: string;
    answeredAt: string | null;
};

export type ImportRowDto = {
    id: string;
    rowNumber: number;
    rawData: unknown;
    mappedData: unknown;
    normalizedData: ImportNormalizedRow | null;
    status: ImportRowStatus;
    issues: ImportIssue[];
    warnings: ImportIssue[];
    confidence: number | null;
    skipped: boolean;
    createdEntityIds: unknown;
};
