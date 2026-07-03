import type { CommitMode, ImportIssue, ImportNormalizedRow } from "./import-session.contract";

export type ImportPreviewRow = {
    rowId: string;
    rowNumber: number;
    status: string;
    normalizedData: ImportNormalizedRow | null;
    issues: ImportIssue[];
    warnings: ImportIssue[];
    willImport: boolean;
};

export type ImportPlanCheck = {
    code: string;
    label: string;
    status: "pass" | "warning" | "block";
    message: string;
    action?: string;
    count?: number;
};

export type ImportPreview = {
    mode: CommitMode;
    canCommit: boolean;
    generatedAt: string;
    planVersion: string;
    summary: {
        createStudents: number;
        createSeats: number;
        createShifts: number;
        createMultiShifts: number;
        createAllocations: number;
        generatePayments: number;
        markPaid: number;
        markWaived: number;
        historicalPaid: number;
        historicalDue: number;
        currentCyclePayments: number;
        skippedHistoricalPayments: number;
        skippedRows: number;
        blockedRows: number;
        warningRows: number;
    };
    checks: ImportPlanCheck[];
    rows: ImportPreviewRow[];
    warnings: string[];
};

export type ImportPaymentPreview = {
    enabled: boolean;
    action?: string;
    cycle?: string;
    historyMode?: string;
    generatedCount?: number;
    skippedHistoricalPayments?: number;
    amount: number | null;
    amountSource: "UPLOADED" | "MONTHLY_FEE" | "SHIFT_PRICE" | "MULTI_SHIFT_PRICE" | "BRANCH_DEFAULT" | "NONE";
    status?: string;
    method?: string;
    referenceId?: string;
    message: string;
    blockers: ImportIssue[];
};

export type ImportRowDraftPreview = {
    rowId: string;
    rowNumber: number;
    status: string;
    normalizedData: ImportNormalizedRow;
    issues: ImportIssue[];
    warnings: ImportIssue[];
    paymentPreview: ImportPaymentPreview;
    suggestedFixes: string[];
};

export type ImportAvailabilityShift = {
    type: "PRIMARY" | "MULTISHIFT";
    shiftId: string;
    multiShiftId?: string;
    name: string;
    startTime: string | null;
    endTime: string | null;
    price: number;
    isReserved: boolean;
    totalSeats: number;
    used: number;
    available: number;
    occupancyPercent: number;
    isFull: boolean;
    studentAlreadyAllocated: boolean;
    componentShiftIds?: string[];
    componentShiftNames?: string[];
    stagedUsed: number;
    stagedAvailable: number;
};

export type ImportAvailabilitySeat = {
    seatId: string;
    label: string;
    occupied: boolean;
    occupiedBy: string | null;
    source: "available" | "existing" | "staged";
    stagedRowId?: string;
    stagedRowNumber?: number;
};

export type ImportAvailabilityPreview = {
    shifts: ImportAvailabilityShift[];
    seatMap: {
        shiftId: string;
        shiftName: string;
        isReserved: boolean;
        totalSeats: number;
        occupiedCount: number;
        availableCount: number;
        seats: ImportAvailabilitySeat[];
    } | null;
    conflicts: ImportIssue[];
};
