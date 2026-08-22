"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, FileUp, ListChecks, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { AppButton, AppPanel, PageShell } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { importSessions } from "@/lib/api/importSessions";
import type { ImportRecipe, ImportRunStartResponse } from "@/lib/api/importSessions";
import type { CapabilityDecision } from "@/types";
import type { ImportAttentionBucket, ImportColumnMapping, ImportEntityType, ImportNormalizedRow, ImportOptions } from "@/importing/contracts/import-session.contract";
import type { ImportReadinessPolicy } from "@/importing/contracts/import-v2.contract";
import { normalizeColumnName } from "@/importing/utils/column-normalizer";
import {
    draftFromImportRowWithFallback,
    hasDirtyImportDraft,
    importRowDraftSourceKey,
    nextImportRowDraft,
    normalizedFromImportDraft,
} from "@/importing/utils/manual-row-draft";
import {
    buildImportWizardSteps,
    deferAllocationOptions,
    joinImportValues,
    isImportPlanFresh,
    labelImportStatus,
    statusTone,
    studentsOnlyImportOptions,
    studentOnlyNormalizedData,
} from "@/importing/utils/import-wizard-view-model";
import {
    pageDescriptionClass,
    pageEyebrowClass,
    pageInsetMetricClass,
    pageMutedTextClass,
    pageProgressTrackClass,
    pageSubtleTextClass,
    pageTitleClass,
} from "@/components/ui/pageSurface";
import { ColumnsStep } from "./ColumnsStep";
import { DecisionsStep } from "./DecisionsStep";
import { PaymentsStep } from "./PaymentsStep";
import { PreviewStep } from "./PreviewStep";
import { ResultStep } from "./ResultStep";
import { RowsStep } from "./RowsStep";
import type { ImportDetail, ImportGoal, ImportRow, PaymentDraft, Plan, RowDraft, RowFilter, RowPreview, Run } from "./types";

type ImportSessionWizardProps = {
    branchId: string;
    sessionId: string;
    importDecision: CapabilityDecision;
};

type PendingNavigation =
    | { kind: "step"; step: "columns" | "rows" | "decisions" | "payments" | "preview" | "result" }
    | { kind: "issue"; issueCode: string }
    | { kind: "row"; rowId: string }
    | { kind: "imports" }
    | { kind: "refresh" };

function detectedPaymentValuesFrom(detail: ImportDetail | null, rows: ImportRow[]) {
    if (detail?.mapping?.analysis?.detectedPaymentValues?.length) {
        return detail.mapping.analysis.detectedPaymentValues;
    }

    return Array.from(new Set(rows
        .map(row => row.normalizedData?.payment?.rawStatus)
        .filter((value): value is string => Boolean(value))));
}

function Metric({
    label,
    value,
    tone = "default",
}: {
    label: string;
    value: string | number;
    tone?: "success" | "warning" | "danger" | "default" | "cyan" | "purple";
}) {
    return (
        <div className={pageInsetMetricClass}>
            <p className={cn("text-xs", pageMutedTextClass)}>{label}</p>
            <p className="mt-1 text-xl font-semibold text-[color:var(--text-primary)]">{String(value)}</p>
            <Badge className="mt-2" variant={tone}>
                {tone === "success" ? "Ready" : tone === "warning" ? "Review" : tone === "danger" ? "Action needed" : "Info"}
            </Badge>
        </div>
    );
}

function paymentDraftFromOptions(options: ImportOptions): PaymentDraft {
    return {
        paid: joinImportValues(options.paymentMapping?.paidValues),
        unpaid: joinImportValues(options.paymentMapping?.unpaidValues),
        waived: joinImportValues(options.paymentMapping?.waivedValues),
        defaultMethod: options.paymentMapping?.defaultMethod ?? "",
    };
}

function pdfExtractionPreviewCells(rawData: Record<string, unknown>) {
    return Object.entries(rawData).map(([key, value]) => `${key}: ${String(value ?? "")}`);
}

const activeRunStatuses = new Set(["QUEUED", "RUNNING", "RETRYABLE_FAILURE", "CANCEL_REQUESTED"]);
const MAX_DISPATCH_RESUME_ATTEMPTS = 3;
const DISPATCH_RESUME_BACKOFF_MS = 5_000;

function idempotencyKey(prefix: string) {
    const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${uuid}`;
}

function normalizedRecipeColumns(columns: string[]) {
    const used = new Set<string>();
    return columns.map(column => {
        const base = normalizeColumnName(column.normalize("NFKC"));
        let normalized = base;
        let suffix = 2;
        while (used.has(normalized)) normalized = `${base} ${suffix++}`;
        used.add(normalized);
        return normalized;
    });
}

function importGoal(value: string | null | undefined): ImportGoal | null {
    return value === "STUDENTS" || value === "STUDENTS_ALLOCATIONS" || value === "FULL" ? value : null;
}

function deriveLegacyGoal(detail: ImportDetail | null): ImportGoal {
    const entities = detail?.mapping?.entityTypesDetected ?? [];
    const options = detail?.mapping?.importOptions;
    if (entities.includes("PAYMENT") || options?.paymentAction && options.paymentAction !== "SKIP_PAYMENTS") return "FULL";
    if (entities.some(entity => ["SEAT", "SHIFT", "ALLOCATION"].includes(entity))) return "STUDENTS_ALLOCATIONS";
    return "STUDENTS";
}

function importGoalLabel(goal: ImportGoal) {
    if (goal === "STUDENTS_ALLOCATIONS") return "Students + seats";
    if (goal === "FULL") return "Full import";
    return "Students";
}

function attentionStep(bucket: ImportAttentionBucket, goal: ImportGoal): "columns" | "rows" | "decisions" | "payments" {
    const signal = `${bucket.code} ${bucket.label} ${(bucket.fields ?? []).join(" ")}`.toLowerCase();
    if (signal.includes("column") || signal.includes("mapping")) return "columns";
    if (goal === "FULL" && signal.includes("payment")) return "payments";
    if (signal.includes("question") || signal.includes("decision") || signal.includes("configuration") || signal.includes("approval")) return "decisions";
    return "rows";
}

function goalAllowsQuestion(goal: ImportGoal, field: string | null) {
    if (goal === "FULL") return true;
    if (field?.startsWith("payment.")) return false;
    if (goal === "STUDENTS" && (field?.startsWith("seat.") || field?.startsWith("shift.") || field?.startsWith("allocation."))) return false;
    return true;
}

export function ImportSessionWizard({ branchId, sessionId, importDecision }: ImportSessionWizardProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [detail, setDetail] = useState<ImportDetail | null>(null);
    const [rowFilter, setRowFilter] = useState<RowFilter>("attention");
    const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
    const [activeStep, setActiveStep] = useState<"columns" | "rows" | "decisions" | "payments" | "preview" | "result">("columns");
    const [loading, setLoading] = useState(true);
    const [analyzing, setAnalyzing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
    const [readinessPolicy, setReadinessPolicy] = useState<ImportReadinessPolicy>("READY_ROWS_ONLY");
    const [plan, setPlan] = useState<Plan | null>(null);
    const [run, setRun] = useState<Run | null>(null);
    const [trackedRunId, setTrackedRunId] = useState<string | null>(() => searchParams.get("runId"));
    const [runLoading, setRunLoading] = useState(false);
    const [runActionLoading, setRunActionLoading] = useState(false);
    const [runPollRevision, setRunPollRevision] = useState(0);
    const [recipes, setRecipes] = useState<ImportRecipe[]>([]);
    const [recipeSaved, setRecipeSaved] = useState<string | null>(null);
    const [columnsDirty, setColumnsDirty] = useState(false);
    const [activeIssueCode, setActiveIssueCode] = useState<string | null>(null);
    const [rowDrafts, setRowDrafts] = useState<Record<string, RowDraft>>({});
    const [rowDraftDirty, setRowDraftDirty] = useState<Record<string, Partial<Record<keyof RowDraft, boolean>>>>({});
    const [rowDraftSourceKeys, setRowDraftSourceKeys] = useState<Record<string, string>>({});
    const [rowFeeLinked, setRowFeeLinked] = useState<Record<string, boolean>>({});
    const [rowPreview, setRowPreview] = useState<RowPreview | null>(null);
    const [rowPreviewLoading, setRowPreviewLoading] = useState(false);
    const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
    const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>({ paid: "", unpaid: "", waived: "", defaultMethod: "" });
    const [pdfAccepted, setPdfAccepted] = useState(false);
    const analysisStartedRef = useRef(false);
    const initialStepResolvedRef = useRef(false);
    const settledRunRef = useRef<string | null>(null);
    const dispatchResumeAttemptsRef = useRef(new Map<string, { attempts: number; nextAttemptAt: number }>());
    const commitKeyRef = useRef<{ planId: string; key: string } | null>(null);
    const loadRequestRef = useRef(0);
    const pollErrorRef = useRef<string | null>(null);
    const pdfReviewRef = useRef<HTMLDivElement>(null);
    const rowFilterRef = useRef(rowFilter);
    rowFilterRef.current = rowFilter;
    const activeIssueCodeRef = useRef(activeIssueCode);
    activeIssueCodeRef.current = activeIssueCode;
    const mutationsDisabled = !importDecision.allowed;
    const mutationBlockReason = importDecision.allowed ? null : importDecision.reason;
    const guardMutation = useCallback(() => {
        if (!mutationsDisabled) return true;
        setError(mutationBlockReason ?? "Import changes are unavailable.");
        return false;
    }, [mutationBlockReason, mutationsDisabled]);

    const load = useCallback(async (
        filter: RowFilter = rowFilterRef.current,
        issueCode: string | null = activeIssueCodeRef.current
    ) => {
        const requestId = ++loadRequestRef.current;
        setLoading(true);
        setError(null);
        try {
            const nextDetail = await importSessions.detail<ImportDetail>(branchId, sessionId, {
                rowFilter: filter,
                issueCode: filter === "attention" ? issueCode : null,
                limit: 120,
            });
            if (requestId !== loadRequestRef.current) return null;
            setDetail(nextDetail);
            return nextDetail;
        } catch (loadError) {
            if (requestId === loadRequestRef.current) {
                setError(loadError instanceof Error ? loadError.message : "Failed to load import session.");
            }
            return null;
        } finally {
            if (requestId === loadRequestRef.current) setLoading(false);
        }
    }, [branchId, sessionId]);

    useEffect(() => {
        void load(rowFilter, activeIssueCode);
    }, [activeIssueCode, load, rowFilter]);

    const trackRun = useCallback((runId: string) => {
        setTrackedRunId(runId);
        const params = new URLSearchParams(searchParams.toString());
        params.set("runId", runId);
        router.replace(`/branch/${branchId}/onboarding/import/${sessionId}?${params.toString()}`, { scroll: false });
    }, [branchId, router, searchParams, sessionId]);

    useEffect(() => {
        const awaitingPdfConfirmation = detail?.sourceType === "PDF"
            && detail.latestRun?.kind === "ANALYSIS"
            && detail.latestRun.status === "WAITING_FOR_USER"
            && detail.sourceConfiguration?.pdfConfirmed !== true;
        if (mutationsDisabled || !detail || detail.status !== "UPLOADED" || awaitingPdfConfirmation || analysisStartedRef.current) return;
        analysisStartedRef.current = true;
        setAnalyzing(true);
        setError(null);
        importSessions.analyze<ImportDetail | ImportRunStartResponse>(branchId, sessionId)
            .then(async result => {
                setPlan(null);
                if ("runId" in result) {
                    trackRun(result.runId);
                    setRunPollRevision(current => current + 1);
                }
                else await load();
            })
            .catch(analyzeError => {
                setError(analyzeError instanceof Error ? analyzeError.message : "Failed to analyze import session.");
            })
            .finally(() => setAnalyzing(false));
    }, [branchId, detail, load, mutationsDisabled, sessionId, trackRun]);

    useEffect(() => {
        if (mutationsDisabled) setConfirmOpen(false);
    }, [mutationsDisabled]);

    useEffect(() => {
        if (trackedRunId || !detail?.latestRun?.id) return;
        setRun(detail.latestRun);
        setTrackedRunId(detail.latestRun.id);
    }, [detail?.latestRun, trackedRunId]);

    useEffect(() => {
        if (!trackedRunId) return;
        let cancelled = false;
        let timer: number | undefined;
        setRunLoading(true);

        const poll = async () => {
            try {
                let nextRun = await importSessions.getRun(branchId, trackedRunId);
                if (cancelled) return;
                const resumeState = dispatchResumeAttemptsRef.current.get(nextRun.id) ?? { attempts: 0, nextAttemptAt: 0 };
                if (
                    nextRun.dispatchRequired
                    && resumeState.attempts < MAX_DISPATCH_RESUME_ATTEMPTS
                    && Date.now() >= resumeState.nextAttemptAt
                ) {
                    const attempts = resumeState.attempts + 1;
                    dispatchResumeAttemptsRef.current.set(nextRun.id, {
                        attempts,
                        nextAttemptAt: Date.now() + DISPATCH_RESUME_BACKOFF_MS * 2 ** (attempts - 1),
                    });
                    const resumed = await importSessions.resumeRun(branchId, nextRun.id);
                    if (cancelled) return;
                    nextRun = {
                        ...nextRun,
                        status: resumed.status,
                        workflowAttached: resumed.workflowAttached,
                        dispatchRequired: resumed.dispatchRequired,
                    };
                    if (!resumed.dispatchRequired && resumed.workflowAttached) {
                        setNotice("Background processing reconnected. Progress is refreshing.");
                    } else {
                        setNotice(attempts >= MAX_DISPATCH_RESUME_ATTEMPTS
                            ? "Background dispatch is still pending after three reconnect attempts. Progress will keep refreshing; reload later to try reconnecting again."
                            : `Background dispatch is still pending. Automatic reconnect attempt ${attempts} of ${MAX_DISPATCH_RESUME_ATTEMPTS} will retry with backoff.`);
                    }
                }
                if (pollErrorRef.current) {
                    const recoveredError = pollErrorRef.current;
                    pollErrorRef.current = null;
                    setError(current => current === recoveredError ? null : current);
                }
                setRun(nextRun);
                const active = activeRunStatuses.has(nextRun.status);
                setAnalyzing(nextRun.kind === "ANALYSIS" && active);
                if (nextRun.kind === "COMMIT") setActiveStep("result");

                if (active) {
                    timer = window.setTimeout(poll, 2000);
                } else {
                    const settledKey = `${nextRun.id}:${nextRun.status}`;
                    if (settledRunRef.current !== settledKey) {
                        settledRunRef.current = settledKey;
                        await load();
                        if (nextRun.kind === "ANALYSIS" && ["COMPLETED", "COMPLETED_WITH_ISSUES"].includes(nextRun.status)) {
                            setNotice("Analysis finished. Review the saved suggestions and issues below.");
                        }
                    }
                }
            } catch (runError) {
                if (!cancelled) {
                    const message = runError instanceof Error ? runError.message : "Failed to refresh import progress.";
                    pollErrorRef.current = message;
                    setError(message);
                    timer = window.setTimeout(poll, 3000);
                }
            } finally {
                if (!cancelled) setRunLoading(false);
            }
        };

        void poll();
        return () => {
            cancelled = true;
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, [branchId, load, runPollRevision, trackedRunId]);

    useEffect(() => {
        let cancelled = false;
        importSessions.listRecipes(branchId)
            .then(items => {
                if (!cancelled) setRecipes(items);
            })
            .catch(() => {
                // Recipe suggestions are optional and must not block an import.
            });
        return () => {
            cancelled = true;
        };
    }, [branchId]);

    const rows = useMemo(() => detail?.rows ?? [], [detail?.rows]);
    const mapping = useMemo(() => detail?.mapping?.columnMappings ?? [], [detail?.mapping?.columnMappings]);
    const options = detail?.mapping?.importOptions ?? {};
    const branchContext = detail?.branchContext;
    const questions = detail?.questions ?? [];
    const goal = importGoal(detail?.goal) ?? importGoal(searchParams.get("goal")) ?? deriveLegacyGoal(detail);
    const visibleQuestions = questions.filter(question => goalAllowsQuestion(goal, question.field));
    const configurationCreation = {
        seats: Boolean(options.createUnknownSeats),
        shifts: Boolean(options.createUnknownShifts),
        multiShifts: Boolean(options.createUnknownMultiShifts),
        approved: Boolean(options.configurationBatchApproved),
    };
    const configurationApprovalNeeded = configurationCreation.seats || configurationCreation.shifts || configurationCreation.multiShifts;
    const sourceColumns = detail?.mapping?.analysis?.sourceProfile?.columns?.map(column => column.column) ?? mapping.map(item => item.sourceColumn);
    const normalizedSourceColumns = normalizedRecipeColumns(sourceColumns);
    const suggestedRecipe = recipes.find(recipe =>
        recipe.goal === goal &&
        (!detail?.sourceType || recipe.sourceType === detail.sourceType) &&
        recipe.sourceColumns.length === normalizedSourceColumns.length &&
        recipe.sourceColumns.every((column, index) => column === normalizedSourceColumns[index])
    ) ?? null;
    const readiness = detail?.summary?.readinessScore ?? 0;
    const selectedRow = rows.find(row => row.id === selectedRowId) ?? rows[0] ?? null;
    const selectedDraft = selectedRow ? rowDrafts[selectedRow.id] : undefined;
    const selectedNormalized = useMemo(
        () => selectedRow && selectedDraft ? normalizedFromImportDraft(selectedRow, selectedDraft, branchContext) : null,
        [branchContext, selectedDraft, selectedRow]
    );
    const detectedPaymentValues = useMemo(() => detectedPaymentValuesFrom(detail, rows), [detail, rows]);
    const allSteps = useMemo(() => {
        const built = buildImportWizardSteps({ detail, plan, readinessPolicy });
        const needsColumnReview = mapping.length === 0 || mapping.some(item => item.needsReview);
        return built.map(step => {
            if (step.id === "columns") {
                return { ...step, state: needsColumnReview ? "needs_attention" as const : "completed" as const, detail: needsColumnReview ? "Confirm column meanings" : "Columns confirmed" };
            }
            if (step.id === "decisions" && configurationApprovalNeeded) {
                return { ...step, state: configurationCreation.approved ? step.state : "needs_attention" as const, detail: configurationCreation.approved ? step.detail : "Approve setup creation" };
            }
            return step;
        });
    }, [configurationApprovalNeeded, configurationCreation.approved, detail, mapping, plan, readinessPolicy]);
    const steps = useMemo(() => allSteps.filter(step => {
        if (step.id === "payments") return goal === "FULL";
        if (step.id === "decisions") return visibleQuestions.length > 0 || configurationApprovalNeeded;
        return true;
    }), [allSteps, configurationApprovalNeeded, goal, visibleQuestions.length]);
    const fixSteps = steps.filter(step => ["columns", "decisions", "rows", "payments"].includes(step.id));
    const attention = detail?.summary?.attention ?? detail?.mapping?.analysis?.attention ?? [];
    const relevantAttention = attention.filter(bucket => {
        const signal = `${bucket.code} ${(bucket.fields ?? []).join(" ")}`.toLowerCase();
        if (goal !== "FULL" && signal.includes("payment")) return false;
        if (goal === "STUDENTS" && ["seat", "shift", "allocation"].some(value => signal.includes(value))) return false;
        return true;
    });
    const activeRowIssue = relevantAttention.find(bucket => bucket.code === activeIssueCode) ?? null;
    const dirtyRowIds = Object.entries(rowDraftDirty)
        .filter(([, dirty]) => hasDirtyImportDraft(dirty))
        .map(([rowId]) => rowId);
    const hasUnsavedRows = dirtyRowIds.length > 0;
    const hasUnsavedQuestions = Object.values(questionDrafts).some(value => value.trim().length > 0);
    const savedPaymentDraft = paymentDraftFromOptions(options);
    const hasUnsavedPaymentWords = options.paymentAction === "IMPORT_PAID_UNPAID"
        && JSON.stringify(paymentDraft) !== JSON.stringify(savedPaymentDraft);
    const hasUnsavedChanges = hasUnsavedRows || columnsDirty || hasUnsavedQuestions || hasUnsavedPaymentWords;
    const activeIndex = steps.findIndex(step => step.id === activeStep);
    const currentStepIndex = activeIndex >= 0 ? activeIndex : 0;
    const activeStepMeta = steps[currentStepIndex];
    const latestCommitRun = run?.kind === "COMMIT" ? run : detail?.latestRun?.kind === "COMMIT" ? detail.latestRun : null;
    const latestAnalysisRun = run?.kind === "ANALYSIS" ? run : detail?.latestRun?.kind === "ANALYSIS" ? detail.latestRun : null;
    const waitingForPdfConfirmation = detail?.sourceType === "PDF"
        && latestAnalysisRun?.status === "WAITING_FOR_USER"
        && detail.sourceConfiguration?.pdfConfirmed !== true;
    const canRetryRun = Boolean(
        detail &&
        latestCommitRun &&
        typeof latestCommitRun.targetRevision === "number" &&
        plan?.canRun &&
        plan.revision > latestCommitRun.targetRevision &&
        isImportPlanFresh(plan, readinessPolicy, detail.draftRevision)
    );

    useEffect(() => {
        if (!hasUnsavedChanges) return;
        const preventUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", preventUnload);
        return () => window.removeEventListener("beforeunload", preventUnload);
    }, [hasUnsavedChanges]);

    useEffect(() => {
        if (!waitingForPdfConfirmation) return;
        pdfReviewRef.current?.focus();
    }, [waitingForPdfConfirmation]);

    useEffect(() => {
        if (!detail || analyzing || ["UPLOADED", "ANALYZING"].includes(detail.status) || initialStepResolvedRef.current) return;
        initialStepResolvedRef.current = true;
        if (run?.kind === "COMMIT" || detail.latestRun?.kind === "COMMIT" || detail.commits?.length || ["COMMITTED", "PARTIAL", "FAILED"].includes(detail.status)) {
            setActiveStep("result");
            return;
        }
        if (detail.status === "READY_TO_COMMIT") {
            setActiveStep("preview");
            return;
        }
        const firstAttention = fixSteps.find(step => step.state === "needs_attention") ?? fixSteps[0];
        if (firstAttention) setActiveStep(firstAttention.id);
    }, [analyzing, detail, fixSteps, run?.kind]);

    useEffect(() => {
        if (!steps.some(step => step.id === activeStep)) {
            setActiveStep(fixSteps[0]?.id ?? "preview");
        }
    }, [activeStep, fixSteps, steps]);

    useEffect(() => {
        setPaymentDraft({
            paid: joinImportValues(options.paymentMapping?.paidValues),
            unpaid: joinImportValues(options.paymentMapping?.unpaidValues),
            waived: joinImportValues(options.paymentMapping?.waivedValues),
            defaultMethod: options.paymentMapping?.defaultMethod ?? "",
        });
    }, [
        options.paymentMapping?.defaultMethod,
        options.paymentMapping?.paidValues,
        options.paymentMapping?.unpaidValues,
        options.paymentMapping?.waivedValues,
    ]);

    useEffect(() => {
        if (rows.length === 0) {
            setSelectedRowId(null);
            return;
        }
        if (!selectedRowId || !rows.some(row => row.id === selectedRowId)) {
            setSelectedRowId(rows[0].id);
        }
    }, [rows, selectedRowId]);

    useEffect(() => {
        if (!selectedRow) return;
        const sourceKey = importRowDraftSourceKey(selectedRow, mapping);
        const shouldRefresh = !rowDrafts[selectedRow.id] ||
            rowDraftSourceKeys[selectedRow.id] !== sourceKey && !hasDirtyImportDraft(rowDraftDirty[selectedRow.id]);

        if (!shouldRefresh) return;

        setRowDrafts(prev => ({
            ...prev,
            [selectedRow.id]: draftFromImportRowWithFallback(selectedRow, mapping),
        }));
        setRowDraftSourceKeys(prev => ({ ...prev, [selectedRow.id]: sourceKey }));
    }, [mapping, rowDraftDirty, rowDraftSourceKeys, rowDrafts, selectedRow]);

    useEffect(() => {
        if (!selectedRow || !selectedNormalized) {
            setRowPreview(null);
            return;
        }

        let alive = true;
        setRowPreview(null);
        setRowPreviewLoading(true);
        const timer = window.setTimeout(() => {
            importSessions.previewRow<RowPreview>(branchId, sessionId, {
                rowId: selectedRow.id,
                normalizedData: selectedNormalized,
            })
                .then(result => {
                    if (alive) setRowPreview(result);
                })
                .catch(previewError => {
                    if (alive) setError(previewError instanceof Error ? previewError.message : "Failed to preview row.");
                })
                .finally(() => {
                    if (alive) setRowPreviewLoading(false);
                });
        }, 250);

        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [branchId, selectedNormalized, selectedRow, sessionId]);

    const saveMapping = async (columnMappings: ImportColumnMapping[], importOptions?: Partial<ImportOptions>) => {
        if (!guardMutation()) return;
        if (!detail) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await importSessions.updateMapping<ImportDetail>(branchId, sessionId, {
                expectedRevision: detail.draftRevision,
                columnMappings,
                importOptions,
            });
            setPlan(null);
            await load();
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : "Failed to save import changes.");
        } finally {
            setSaving(false);
        }
    };

    const updateOption = async (importOptions: Partial<ImportOptions>) => {
        await saveMapping(mapping, importOptions);
    };

    const updateRowDraft = (rowId: string, field: keyof RowDraft, value: string) => {
        const current = rowDrafts[rowId];
        if (!current) return;

        const result = nextImportRowDraft({
            draft: current,
            dirty: rowDraftDirty[rowId],
            field,
            value,
            context: branchContext,
            linkFeeToSelection: rowFeeLinked[rowId],
        });
        setRowDrafts(prev => ({ ...prev, [rowId]: result.draft }));
        setRowDraftDirty(prev => ({ ...prev, [rowId]: result.dirty }));
    };

    const updateRowFeeLink = (rowId: string, linked: boolean) => {
        setRowFeeLinked(prev => ({ ...prev, [rowId]: linked }));
        if (!linked) return;

        const current = rowDrafts[rowId];
        if (!current) return;
        const field = current.multiShift ? "multiShift" : current.shift ? "shift" : null;
        if (!field) return;

        const result = nextImportRowDraft({
            draft: current,
            dirty: rowDraftDirty[rowId],
            field,
            value: current[field],
            context: branchContext,
            linkFeeToSelection: true,
        });
        setRowDrafts(prev => ({ ...prev, [rowId]: result.draft }));
        setRowDraftDirty(prev => ({ ...prev, [rowId]: result.dirty }));
    };

    const resetSelectedDraft = () => {
        if (!selectedRow) return;
        setRowDrafts(prev => ({ ...prev, [selectedRow.id]: draftFromImportRowWithFallback(selectedRow, mapping) }));
        setRowDraftDirty(prev => {
            const next = { ...prev };
            delete next[selectedRow.id];
            return next;
        });
        setNotice("Unsaved changes for this row were reset.");
    };

    const saveSelectedRow = async (overrideNormalizedData?: ImportNormalizedRow) => {
        if (!guardMutation()) return false;
        if (!detail || !selectedRow || (!selectedDraft && !overrideNormalizedData)) return false;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            const normalizedData = overrideNormalizedData ?? normalizedFromImportDraft(selectedRow, selectedDraft as RowDraft, branchContext);
            await importSessions.updateRows<ImportDetail>(branchId, sessionId, {
                expectedRevision: detail.draftRevision,
                edits: [{ rowId: selectedRow.id, normalizedData }],
            });
            setPlan(null);
            setRowDrafts(prev => {
                const next = { ...prev };
                delete next[selectedRow.id];
                return next;
            });
            setRowDraftDirty(prev => {
                const next = { ...prev };
                delete next[selectedRow.id];
                return next;
            });
            setRowDraftSourceKeys(prev => {
                const next = { ...prev };
                delete next[selectedRow.id];
                return next;
            });
            setNotice(overrideNormalizedData
                ? "Saved as student only. Allocation and payment data were cleared for this row."
                : "Row saved. If it no longer needs attention, it may move out of the current filter.");
            await load();
            return true;
        } catch (rowError) {
            setError(rowError instanceof Error ? rowError.message : "Failed to save row.");
            return false;
        } finally {
            setSaving(false);
        }
    };

    const saveAndNextRow = async () => {
        if (!selectedRow) return;
        const selectedIndex = rows.findIndex(row => row.id === selectedRow.id);
        const nextRowId = rows[selectedIndex + 1]?.id ?? rows[selectedIndex - 1]?.id ?? null;
        const saved = await saveSelectedRow();
        if (saved && nextRowId) setSelectedRowId(nextRowId);
    };

    const skipSelectedRow = async () => {
        if (!guardMutation()) return;
        if (!detail || !selectedRow) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await importSessions.updateRows<ImportDetail>(branchId, sessionId, selectedRow.skipped
                ? { expectedRevision: detail.draftRevision, unskipRowIds: [selectedRow.id] }
                : { expectedRevision: detail.draftRevision, skipRowIds: [selectedRow.id] });
            setPlan(null);
            setNotice(selectedRow.skipped ? "Row restored to the review queue." : "Row skipped for this import.");
            await load();
        } catch (rowError) {
            setError(rowError instanceof Error ? rowError.message : "Failed to update row.");
        } finally {
            setSaving(false);
        }
    };

    const bulkSetRowsSkipped = async (rowIds: string[], skipped: boolean) => {
        if (!guardMutation()) return false;
        if (!detail || rowIds.length === 0) return false;
        if (hasUnsavedChanges) {
            setError("Save or discard unsaved row changes before applying a bulk action.");
            return false;
        }
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await importSessions.updateRows<ImportDetail>(branchId, sessionId, skipped
                ? { expectedRevision: detail.draftRevision, skipRowIds: rowIds }
                : { expectedRevision: detail.draftRevision, unskipRowIds: rowIds });
            setPlan(null);
            setNotice(`${skipped ? "Skipped" : "Restored"} ${rowIds.length} selected row${rowIds.length === 1 ? "" : "s"}.`);
            await load();
            return true;
        } catch (rowError) {
            setError(rowError instanceof Error ? rowError.message : "Failed to update the selected rows.");
            return false;
        } finally {
            setSaving(false);
        }
    };

    const bulkSetAffectedIssueSkipped = async (issueCode: string, skipped: boolean) => {
        if (!guardMutation()) return false;
        if (!detail || !issueCode) return false;
        if (hasUnsavedChanges) {
            setError("Save or discard unsaved row changes before applying an all-affected action.");
            return false;
        }
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await importSessions.updateRows<ImportDetail>(branchId, sessionId, {
                expectedRevision: detail.draftRevision,
                bulkAction: { action: skipped ? "SKIP" : "UNSKIP", issueCode },
            });
            setPlan(null);
            setNotice(`${skipped ? "Skipped" : "Restored"} every row currently affected by ${issueCode.replace(/_/g, " ")}.`);
            await load();
            return true;
        } catch (rowError) {
            setError(rowError instanceof Error ? rowError.message : "Failed to update all affected rows.");
            return false;
        } finally {
            setSaving(false);
        }
    };

    const answerQuestion = async (questionId: string, answer: unknown) => {
        if (!guardMutation()) return;
        if (!detail) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await importSessions.answerQuestion<ImportDetail>(branchId, sessionId, {
                expectedRevision: detail.draftRevision,
                questionId,
                answer,
                applyToAffectedRows: true,
            });
            setPlan(null);
            setQuestionDrafts(prev => ({ ...prev, [questionId]: "" }));
            setNotice("Decision saved. The import checks were refreshed.");
            await load();
        } catch (questionError) {
            setError(questionError instanceof Error ? questionError.message : "Failed to answer question.");
        } finally {
            setSaving(false);
        }
    };

    const loadMoreRows = async () => {
        if (!detail?.rowPage?.hasMore || !detail.rowPage.nextCursor) return;
        const requestedFilter = rowFilter;
        const requestedIssueCode = activeIssueCode;
        setSaving(true);
        setError(null);
        try {
            const nextPage = await importSessions.detail<ImportDetail>(branchId, sessionId, {
                rowFilter,
                issueCode: rowFilter === "attention" ? requestedIssueCode : null,
                limit: 120,
                cursor: detail.rowPage.nextCursor,
            });
            setDetail(prev => {
                if (
                    !prev
                    || prev.rowPage?.filter !== requestedFilter
                    || nextPage.rowPage?.filter !== requestedFilter
                    || prev.rowPage?.issueCode !== requestedIssueCode
                    || nextPage.rowPage?.issueCode !== requestedIssueCode
                ) return prev;
                return {
                    ...nextPage,
                    rows: [...prev.rows, ...nextPage.rows],
                };
            });
        } catch (loadMoreError) {
            setError(loadMoreError instanceof Error ? loadMoreError.message : "Failed to load more rows.");
        } finally {
            setSaving(false);
        }
    };

    const loadPlan = useCallback(async () => {
        if (!detail || !guardMutation()) return;
        setSaving(true);
        setError(null);
        try {
            setPlan(await importSessions.createPlan(branchId, sessionId, readinessPolicy, detail.draftRevision));
        } catch (planError) {
            setError(planError instanceof Error ? planError.message : "Failed to build the reviewed import plan.");
        } finally {
            setSaving(false);
        }
    }, [branchId, detail, guardMutation, readinessPolicy, sessionId]);

    const confirmPdfExtraction = async () => {
        if (!waitingForPdfConfirmation || !pdfAccepted || !guardMutation()) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            const started = await importSessions.analyze<ImportRunStartResponse>(branchId, sessionId, {
                confirmPdfExtraction: true,
            });
            setPdfAccepted(false);
            setRun(current => current && current.id === started.runId
                ? { ...current, status: started.status }
                : current);
            trackRun(started.runId);
            setRunPollRevision(value => value + 1);
            setNotice("PDF extraction confirmed. Analysis is running in the background.");
        } catch (confirmationError) {
            setError(confirmationError instanceof Error ? confirmationError.message : "PDF extraction could not be confirmed.");
        } finally {
            setSaving(false);
        }
    };

    const retryAnalysis = async () => {
        if (!guardMutation()) return;
        setAnalyzing(true);
        setError(null);
        setNotice("Reading the source and rebuilding import suggestions...");
        try {
            const result = await importSessions.analyze<ImportDetail | ImportRunStartResponse>(branchId, sessionId);
            setPlan(null);
            if ("runId" in result) {
                trackRun(result.runId);
                setNotice("Analysis is running in the background. This page will refresh when it finishes.");
            } else {
                await load();
                setNotice("Analysis refreshed. Review the items that still need attention.");
            }
        } catch (analyzeError) {
            setError(analyzeError instanceof Error ? analyzeError.message : "Failed to analyze import session.");
            setNotice(null);
        } finally {
            setAnalyzing(false);
        }
    };

    const commit = async () => {
        if (!guardMutation()) {
            setConfirmOpen(false);
            return;
        }
        if (!detail || !plan?.id || !plan.canRun || !isImportPlanFresh(plan, readinessPolicy, detail.draftRevision)) {
            setConfirmOpen(false);
            setError("Refresh the reviewed plan for the latest saved revision before importing.");
            setActiveStep("preview");
            return;
        }
        const plannedStudents = plan.summary?.mutations.students ?? plan.mutationSummary?.students ?? plan.readyRows;
        const plannedSkipped = plan.blockedRows + plan.skippedRows;
        const existingKey = commitKeyRef.current;
        const commitKey = existingKey?.planId === plan.id ? existingKey.key : idempotencyKey(`import-${sessionId}`);
        commitKeyRef.current = { planId: plan.id, key: commitKey };

        setSaving(true);
        setError(null);
        setNotice(`Starting ${plannedStudents} planned student${plannedStudents === 1 ? "" : "s"}${plannedSkipped > 0 ? ` while keeping ${plannedSkipped} row${plannedSkipped === 1 ? "" : "s"} staged` : ""}.`);
        setConfirmOpen(false);
        try {
            const result = await importSessions.commitPlan(branchId, sessionId, plan.id, commitKey);
            trackRun(result.runId);
            setActiveStep("result");
            setNotice("Import started in the background. You can leave safely and resume from this session.");
        } catch (commitError) {
            setConfirmOpen(false);
            setError(commitError instanceof Error ? commitError.message : "Import failed.");
            setNotice(null);
            setActiveStep("preview");
            await load();
        } finally {
            setSaving(false);
        }
    };

    const cancelRun = async () => {
        if (!run || !guardMutation()) return;
        setRunActionLoading(true);
        setError(null);
        try {
            await importSessions.cancelRun(branchId, run.id);
            setNotice("Cancellation requested. Work already completed remains saved.");
            setRun(await importSessions.getRun(branchId, run.id));
        } catch (runError) {
            setError(runError instanceof Error ? runError.message : "Failed to cancel the import run.");
        } finally {
            setRunActionLoading(false);
        }
    };

    const retryRun = async () => {
        if (!run || !guardMutation()) return;
        if (!detail || !plan?.id || !canRetryRun) {
            setNotice("Fix the unresolved rows or decisions, then open Review & import and build a newer plan before retrying.");
            setActiveStep((fixSteps.find(step => step.state === "needs_attention") ?? fixSteps.find(step => step.id === "rows") ?? fixSteps[0])?.id ?? "rows");
            return;
        }
        setRunActionLoading(true);
        setError(null);
        try {
            const result = await importSessions.retryRun(branchId, run.id, plan.id, idempotencyKey(`retry-${run.id}-${plan.id}`));
            setRun(null);
            trackRun(result.runId);
            setNotice("A new background run was started for the remaining work.");
            setActiveStep("result");
        } catch (runError) {
            setError(runError instanceof Error ? runError.message : "Failed to retry the import run.");
        } finally {
            setRunActionLoading(false);
        }
    };

    const exportRunErrors = async (format: "csv" | "xlsx") => {
        if (!run) return;
        setRunActionLoading(true);
        setError(null);
        try {
            const blob = await importSessions.exportRunErrors(branchId, run.id, format);
            const href = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = href;
            link.download = `import-errors-${run.id}.${format}`;
            document.body.appendChild(link);
            try {
                link.click();
            } finally {
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(href), 0);
            }
        } catch (runError) {
            setError(runError instanceof Error ? runError.message : "Failed to download the import error report.");
        } finally {
            setRunActionLoading(false);
        }
    };

    const saveRecipe = async (name: string) => {
        if (!detail || !guardMutation()) return;
        const validEntityTypes = new Set<ImportEntityType>(["STUDENT", "SEAT", "SHIFT", "ALLOCATION", "PAYMENT"]);
        const entityTypes = (detail.mapping?.entityTypesDetected ?? [])
            .filter((entity): entity is ImportEntityType => validEntityTypes.has(entity as ImportEntityType));
        setRunActionLoading(true);
        setError(null);
        try {
            const recipe = await importSessions.createRecipe(branchId, {
                name,
                goal,
                sourceType: detail.sourceType ?? "OTHER",
                sourceColumns,
                entityTypes: entityTypes.length > 0 ? entityTypes : ["STUDENT"],
                columnMappings: mapping.map(item => ({ sourceColumn: item.sourceColumn, targetField: item.targetField })),
            });
            setRecipeSaved(recipe.name);
            setRecipes(current => [recipe, ...current.filter(item => item.id !== recipe.id)]);
        } catch (recipeError) {
            setError(recipeError instanceof Error ? recipeError.message : "Failed to save the import recipe.");
        } finally {
            setRunActionLoading(false);
        }
    };

    const performNavigation = (navigation: PendingNavigation) => {
        if (navigation.kind === "step") {
            setActiveStep(navigation.step);
            if (navigation.step !== "rows") setActiveIssueCode(null);
        }
        if (navigation.kind === "issue") {
            setRowFilter("attention");
            setActiveIssueCode(navigation.issueCode);
            setActiveStep("rows");
        }
        if (navigation.kind === "row") setSelectedRowId(navigation.rowId);
        if (navigation.kind === "imports") router.push(`/branch/${branchId}/onboarding/import`);
        if (navigation.kind === "refresh") void load();
    };

    const requestNavigation = (navigation: PendingNavigation) => {
        if (hasUnsavedChanges) {
            setPendingNavigation(navigation);
            return;
        }
        performNavigation(navigation);
    };

    const discardDraftsAndContinue = () => {
        const navigation = pendingNavigation;
        setPendingNavigation(null);
        setRowDrafts({});
        setRowDraftDirty({});
        setRowDraftSourceKeys({});
        setQuestionDrafts({});
        setPaymentDraft(paymentDraftFromOptions(options));
        setColumnsDirty(false);
        if (navigation) performNavigation(navigation);
    };

    const goNext = () => {
        const next = steps[Math.min(currentStepIndex + 1, steps.length - 1)];
        if (next) requestNavigation({ kind: "step", step: next.id });
    };

    const goBackStep = () => {
        const previous = steps[Math.max(currentStepIndex - 1, 0)];
        if (previous) requestNavigation({ kind: "step", step: previous.id });
    };

    if (!detail && loading) {
        return (
            <PageShell>
                <div className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]" role="status" aria-live="polite">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading import session...
                </div>
            </PageShell>
        );
    }

    return (
        <PageShell>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <p className={pageEyebrowClass}>Data import</p>
                    <h1 className={pageTitleClass}>Import review</h1>
                    <p className={pageDescriptionClass}>{detail?.fileName ?? "Review staged records before import."}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="cyan">{importGoalLabel(goal)}</Badge>
                    {detail?.status && <Badge variant={statusTone(detail.status)}>{labelImportStatus(detail.status)}</Badge>}
                    <AppButton variant="quiet" icon={ArrowLeft} onClick={() => requestNavigation({ kind: "imports" })}>
                        All imports
                    </AppButton>
                </div>
            </div>

            {error && (
                <div className="flex flex-col gap-3 rounded-[8px] border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200 sm:flex-row sm:items-center sm:justify-between" role="alert">
                    <span>{error}</span>
                    {detail?.status === "UPLOADED" && !analyzing && !waitingForPdfConfirmation && (
                        <AppButton size="sm" variant="secondary" onClick={retryAnalysis}>Retry analysis</AppButton>
                    )}
                </div>
            )}

            {mutationBlockReason && importDecision.blocker !== "permission" && (
                <div id="import-session-mutation-blocker" className="flex flex-col gap-2 rounded-[8px] border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between" role="status">
                    <span>Import changes are disabled. {mutationBlockReason}</span>
                    {importDecision.recoveryHref ? (
                        <Link href={importDecision.recoveryHref} className="shrink-0 font-semibold underline underline-offset-4">
                            Resolve access
                        </Link>
                    ) : null}
                </div>
            )}

            {notice && !error && (
                <div className="rounded-[8px] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-3 text-sm text-[color:var(--ui-badge-cyan-text)]" role="status" aria-live="polite">
                    {notice}
                </div>
            )}

            {analyzing && (
                <div className="flex items-center gap-3 rounded-[8px] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-3 text-sm text-[color:var(--ui-badge-cyan-text)]" role="status" aria-live="polite">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Analyzing source data. Manual fallback remains available if AI is unavailable.
                </div>
            )}

            {detail && waitingForPdfConfirmation && (
                <AppPanel title="Review PDF extraction" description="PDF table extraction is beta. Confirm the persisted text rows before analysis starts.">
                    <div ref={pdfReviewRef} tabIndex={-1} aria-label="PDF extraction review" className="space-y-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]">
                        <div className={cn("p-4 text-xs leading-5", pageInsetMetricClass)}>
                            Compare this sample with the original PDF. Scanned images are not read because OCR is not enabled.
                        </div>
                        <div className="overflow-x-auto rounded-[8px] border border-[color:var(--ui-table-border)]" tabIndex={0} aria-label="Persisted PDF extraction preview">
                            <table className="w-full min-w-[560px] text-left text-xs">
                                <caption className="sr-only">Persisted extracted PDF sample rows</caption>
                                <tbody>
                                    {(detail.extractionPreview ?? []).map(row => (
                                        <tr key={row.rowNumber} className="border-t border-[color:var(--ui-table-border)] first:border-t-0">
                                            <th scope="row" className="w-20 p-3">Row {row.rowNumber}</th>
                                            <td className="p-3 text-[color:var(--text-secondary)]">{pdfExtractionPreviewCells(row.rawData).join(" · ") || "Empty row"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {(detail.extractionPreview?.length ?? 0) === 0 && loading && (
                            <p className={cn("text-sm", pageMutedTextClass)} role="status">Loading the persisted extraction preview...</p>
                        )}
                        <label className="flex items-start gap-3 text-sm text-[color:var(--text-primary)]">
                            <input
                                type="checkbox"
                                checked={pdfAccepted}
                                disabled={saving || mutationsDisabled || (detail.extractionPreview?.length ?? 0) === 0}
                                onChange={event => setPdfAccepted(event.target.checked)}
                                className="mt-0.5 h-4 w-4"
                            />
                            <span>I reviewed the sample and confirm that the extracted columns and rows match the PDF.</span>
                        </label>
                        <div className="flex flex-wrap gap-2">
                            <AppButton
                                variant="primary"
                                onClick={confirmPdfExtraction}
                                disabled={!pdfAccepted || mutationsDisabled || (detail.extractionPreview?.length ?? 0) === 0}
                                aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                isLoading={saving}
                            >
                                Confirm and analyze PDF
                            </AppButton>
                            <AppButton variant="secondary" onClick={() => requestNavigation({ kind: "imports" })} disabled={saving}>
                                Choose a different source
                            </AppButton>
                        </div>
                    </div>
                </AppPanel>
            )}

            {detail && !waitingForPdfConfirmation && (
                <>
                    <AppPanel contentClassName="space-y-5">
                        <nav aria-label="Import progress" className="grid gap-2 sm:grid-cols-3">
                            {[
                                { id: "upload", label: "Upload", detail: "Source staged", icon: FileUp },
                                { id: "fix", label: "Fix issues", detail: relevantAttention.length > 0 ? `${relevantAttention.length} issue groups` : "Checks reviewed", icon: ListChecks },
                                { id: "review", label: "Review & import", detail: run?.kind === "COMMIT" || detail.commits?.length ? "Progress / result available" : plan ? "Reviewed plan ready" : "Build final plan", icon: ShieldCheck },
                            ].map((stage, index) => {
                                const stageActive = stage.id === "fix"
                                    ? fixSteps.some(step => step.id === activeStep)
                                    : stage.id === "review"
                                        ? ["preview", "result"].includes(activeStep)
                                        : false;
                                const StageIcon = stage.icon;
                                return (
                                    <button
                                        key={stage.id}
                                        type="button"
                                        aria-current={stageActive ? "step" : undefined}
                                        onClick={() => {
                                            if (stage.id === "upload") requestNavigation({ kind: "imports" });
                                            if (stage.id === "fix") requestNavigation({ kind: "step", step: (fixSteps.find(step => step.state === "needs_attention") ?? fixSteps[0])?.id ?? "rows" });
                                            if (stage.id === "review") requestNavigation({ kind: "step", step: run?.kind === "COMMIT" || detail.commits?.length ? "result" : "preview" });
                                        }}
                                        className={cn(
                                            "flex min-h-20 items-center gap-3 rounded-[8px] border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]",
                                            stageActive
                                                ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]"
                                                : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] hover:bg-white/[0.04]"
                                        )}
                                    >
                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--ui-form-surface-border)] text-xs font-semibold">
                                            {stage.id === "upload" || stage.id === "fix" && relevantAttention.length === 0 || stage.id === "review" && (run?.kind === "COMMIT" || Boolean(detail.commits?.length)) ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : index + 1}
                                        </span>
                                        <span className="min-w-0"><span className="flex items-center gap-2 text-sm font-semibold text-[color:var(--text-primary)]"><StageIcon className="h-4 w-4" />{stage.label}</span><span className={cn("mt-1 block text-xs", pageMutedTextClass)}>{stage.detail}</span></span>
                                    </button>
                                );
                            })}
                        </nav>

                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <Metric label="Ready to import" value={detail.summary?.readyRows ?? 0} tone="success" />
                            <Metric label="Needs review" value={(detail.summary?.needsReviewRows ?? 0) + (detail.summary?.duplicateRows ?? 0)} tone={(detail.summary?.needsReviewRows ?? 0) + (detail.summary?.duplicateRows ?? 0) > 0 ? "warning" : "success"} />
                            <Metric label="Blocked" value={(detail.summary?.blockedRows ?? 0) + (detail.summary?.conflictRows ?? 0)} tone={(detail.summary?.blockedRows ?? 0) + (detail.summary?.conflictRows ?? 0) > 0 ? "danger" : "success"} />
                            <Metric label="Skipped" value={detail.summary?.skippedRows ?? 0} tone="default" />
                        </div>
                        <div>
                            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                                <span className={pageMutedTextClass}>Import readiness</span>
                                <span className="font-semibold text-[color:var(--text-primary)]">{readiness}%</span>
                            </div>
                            <div className={pageProgressTrackClass} role="progressbar" aria-label="Import readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readiness}>
                                <div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: `${Math.max(0, Math.min(100, readiness))}%` }} />
                            </div>
                        </div>

                        {fixSteps.some(step => step.id === activeStep) && (
                            <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Fix import issues">
                                {fixSteps.map(step => (
                                    <button
                                        key={step.id}
                                        type="button"
                                        aria-current={activeStep === step.id ? "step" : undefined}
                                        onClick={() => requestNavigation({ kind: "step", step: step.id })}
                                        className={cn(
                                            "min-h-11 shrink-0 rounded-[8px] border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]",
                                            activeStep === step.id ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100" : "border-[color:var(--ui-form-surface-border)] text-[color:var(--text-secondary)]"
                                        )}
                                    >
                                        <span className="font-semibold">{step.label}</span>
                                        {typeof step.count === "number" && step.count > 0 && <span className="ml-2">{step.count}</span>}
                                    </button>
                                ))}
                            </nav>
                        )}
                    </AppPanel>

                    {relevantAttention.length > 0 && fixSteps.some(step => step.id === activeStep) && (
                        <AppPanel title="Fix these first" description="Open an issue group to jump to the best place to resolve it.">
                            <ul className="grid gap-3 lg:grid-cols-2">
                                {relevantAttention.map(bucket => {
                                    const target = attentionStep(bucket, goal);
                                    const issueActive = target === "rows" && activeIssueCode === bucket.code;
                                    return (
                                        <li key={bucket.code}>
                                            <button
                                                type="button"
                                                aria-pressed={target === "rows" ? issueActive : undefined}
                                                onClick={() => requestNavigation(target === "rows"
                                                    ? { kind: "issue", issueCode: bucket.code }
                                                    : { kind: "step", step: target })}
                                                className={cn(
                                                    "flex h-full w-full items-start gap-3 p-3 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]",
                                                    pageInsetMetricClass,
                                                    issueActive && "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]"
                                                )}
                                            >
                                                <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", bucket.severity === "error" ? "text-red-300" : bucket.severity === "warning" ? "text-amber-300" : "text-cyan-300")} />
                                                <span className="min-w-0 flex-1">
                                                    <span className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-[color:var(--text-primary)]">{bucket.label}</span><Badge variant={bucket.severity === "error" ? "danger" : bucket.severity === "warning" ? "warning" : "cyan"}>{bucket.count}</Badge></span>
                                                    <span className={cn("mt-1 block text-xs leading-5", pageMutedTextClass)}>{bucket.action ?? bucket.message}</span>
                                                    {bucket.sampleRowNumbers?.length ? <span className={cn("mt-1 block text-[11px]", pageSubtleTextClass)}>Example rows: {bucket.sampleRowNumbers.slice(0, 4).join(", ")}</span> : null}
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </AppPanel>
                    )}

                    {activeStep === "columns" && (
                        <ColumnsStep
                            detail={detail}
                            goal={goal}
                            saving={saving}
                            mutationsDisabled={mutationsDisabled}
                            suggestedRecipe={suggestedRecipe}
                            onDirtyChange={setColumnsDirty}
                            onSave={columnMappings => saveMapping(columnMappings)}
                        />
                    )}

                    {activeStep === "rows" && (
                        <RowsStep
                            branchId={branchId}
                            sessionId={sessionId}
                            detail={detail}
                            rows={rows}
                            rowFilter={rowFilter}
                            selectedRow={selectedRow}
                            selectedDraft={selectedDraft}
                            rowPreview={rowPreview}
                            rowPreviewLoading={rowPreviewLoading}
                            saving={saving}
                            mutationsDisabled={mutationsDisabled}
                            goal={goal}
                            dirty={selectedRow ? dirtyRowIds.includes(selectedRow.id) : false}
                            activeIssue={activeRowIssue ? {
                                code: activeRowIssue.code,
                                label: activeRowIssue.label,
                                count: activeRowIssue.count,
                            } : null}
                            onFilterChange={filter => {
                                setActiveIssueCode(null);
                                setRowFilter(filter);
                                setSelectedRowId(null);
                            }}
                            onSelectRow={rowId => {
                                if (rowId !== selectedRow?.id) requestNavigation({ kind: "row", rowId });
                            }}
                            onLoadMore={loadMoreRows}
                            onDraftChange={updateRowDraft}
                            onFeeLinkChange={updateRowFeeLink}
                            feeLinked={selectedRow ? Boolean(rowFeeLinked[selectedRow.id]) : false}
                            onSaveRow={() => saveSelectedRow()}
                            onSaveAndNext={saveAndNextRow}
                            onResetRow={resetSelectedDraft}
                            onSkipRow={skipSelectedRow}
                            onBulkSetSkipped={bulkSetRowsSkipped}
                            onBulkAffectedIssue={bulkSetAffectedIssueSkipped}
                            onImportStudentOnly={() => {
                                if (selectedRow && selectedDraft) {
                                    saveSelectedRow(studentOnlyNormalizedData(normalizedFromImportDraft(selectedRow, selectedDraft, branchContext)));
                                }
                            }}
                        />
                    )}

                    {activeStep === "decisions" && (
                        <DecisionsStep
                            questions={visibleQuestions}
                            goal={goal}
                            questionDrafts={questionDrafts}
                            saving={saving}
                            mutationsDisabled={mutationsDisabled}
                            onDraftChange={(questionId, value) => setQuestionDrafts(prev => ({ ...prev, [questionId]: value }))}
                            onAnswer={answerQuestion}
                            onDeferAllocations={() => updateOption(deferAllocationOptions())}
                            onStudentsOnly={() => updateOption(studentsOnlyImportOptions())}
                            configurationCreation={configurationCreation}
                            onConfigurationApproval={approved => updateOption({ configurationBatchApproved: approved })}
                        />
                    )}

                    {activeStep === "payments" && goal === "FULL" && (
                        <PaymentsStep
                            options={options}
                            detectedPaymentValues={detectedPaymentValues}
                            paymentDraft={paymentDraft}
                            saving={saving}
                            mutationsDisabled={mutationsDisabled}
                            onPaymentDraftChange={setPaymentDraft}
                            onUpdateOptions={updateOption}
                        />
                    )}

                    {activeStep === "preview" && (
                        <PreviewStep
                            key={plan?.id ?? "unplanned"}
                            branchId={branchId}
                            sessionId={sessionId}
                            plan={plan}
                            importOptions={options}
                            readinessPolicy={readinessPolicy}
                            currentRevision={detail.draftRevision}
                            saving={saving}
                            mutationsDisabled={mutationsDisabled}
                            onPolicyChange={policy => {
                                setReadinessPolicy(policy);
                                setPlan(null);
                            }}
                            onRefreshPlan={loadPlan}
                            onConfirmImport={() => {
                                if (guardMutation()) setConfirmOpen(true);
                            }}
                        />
                    )}

                    {activeStep === "result" && (
                        <ResultStep
                            branchId={branchId}
                            detail={detail}
                            run={latestCommitRun}
                            runLoading={runLoading}
                            actionLoading={runActionLoading}
                            onGoPreview={() => requestNavigation({ kind: "step", step: "preview" })}
                            onCancelRun={cancelRun}
                            onRetryRun={retryRun}
                            canRetryRun={canRetryRun}
                            onRepairRun={() => {
                                setNotice("Fix the unresolved rows or decisions, then return to Review & import and build a newer plan.");
                                requestNavigation({ kind: "step", step: (fixSteps.find(step => step.state === "needs_attention") ?? fixSteps.find(step => step.id === "rows") ?? fixSteps[0])?.id ?? "rows" });
                            }}
                            onExportErrors={exportRunErrors}
                            onSaveRecipe={saveRecipe}
                            recipeSaved={recipeSaved}
                        />
                    )}

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <AppButton variant="quiet" icon={RotateCcw} onClick={() => requestNavigation({ kind: "refresh" })} isLoading={loading}>
                            Refresh session
                        </AppButton>
                        <div className="flex flex-wrap gap-2">
                            <AppButton variant="secondary" onClick={goBackStep} disabled={currentStepIndex === 0}>
                                Previous
                            </AppButton>
                            <AppButton variant="primary" rightIcon={ArrowRight} onClick={goNext} disabled={currentStepIndex === steps.length - 1}>
                                Next: {steps[Math.min(currentStepIndex + 1, steps.length - 1)]?.label ?? activeStepMeta?.label}
                            </AppButton>
                        </div>
                    </div>

                    <ConfirmDialog
                        isOpen={confirmOpen}
                        onClose={() => setConfirmOpen(false)}
                        onConfirm={commit}
                        loading={saving}
                        variant="warning"
                        title="Confirm final import"
                        description={plan
                            ? readinessPolicy === "READY_ROWS_ONLY"
                                ? `Start a background run for ${plan.readyRows} ready row${plan.readyRows === 1 ? "" : "s"}. ${plan.blockedRows + plan.skippedRows} row${plan.blockedRows + plan.skippedRows === 1 ? "" : "s"} will stay in this workspace.`
                                : "Every row passed the reviewed checks. Work runs in durable batches, and completed records remain saved if a later item fails."
                            : "Refresh the reviewed plan before importing."}
                        confirmText={readinessPolicy === "READY_ROWS_ONLY" ? "Import ready rows" : "Start checked import"}
                    />

                    <ConfirmDialog
                        isOpen={Boolean(pendingNavigation)}
                        onClose={() => setPendingNavigation(null)}
                        onConfirm={discardDraftsAndContinue}
                        variant="warning"
                        title="Discard unsaved import changes?"
                        description={[
                            columnsDirty ? "Column meaning changes are not saved." : null,
                            hasUnsavedRows ? `${dirtyRowIds.length} row${dirtyRowIds.length === 1 ? " has" : "s have"} unsaved edits.` : null,
                            hasUnsavedQuestions ? "A custom decision answer is not saved." : null,
                            hasUnsavedPaymentWords ? "Payment word mappings are not saved." : null,
                            "Save these changes or discard them before continuing.",
                        ].filter(Boolean).join(" ")}
                        confirmText="Discard and continue"
                        cancelText="Keep editing"
                    />
                </>
            )}
        </PageShell>
    );
}
