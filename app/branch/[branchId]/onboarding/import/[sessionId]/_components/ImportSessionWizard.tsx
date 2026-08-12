"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, RotateCcw } from "lucide-react";
import { AppButton, AppPanel, PageShell } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { importSessions } from "@/lib/api/importSessions";
import type { CapabilityDecision } from "@/types";
import type { CommitMode, ImportColumnMapping, ImportNormalizedRow, ImportOptions } from "@/importing/contracts/import-session.contract";
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
import type { ImportDetail, ImportRow, PaymentDraft, Preview, RowDraft, RowFilter, RowPreview } from "./types";

type ImportSessionWizardProps = {
    branchId: string;
    sessionId: string;
    importDecision: CapabilityDecision;
};

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
            <Badge className="mt-2" variant={tone}>{label}</Badge>
        </div>
    );
}

type CommitResponse = {
    status: string;
    summary?: Record<string, number>;
    errors?: unknown[];
};

function sessionStatusFromCommit(status: string) {
    if (status === "SUCCESS") return "COMMITTED";
    if (status === "PARTIAL") return "PARTIAL";
    if (status === "FAILED") return "FAILED";
    return "COMMITTING";
}

export function ImportSessionWizard({ branchId, sessionId, importDecision }: ImportSessionWizardProps) {
    const router = useRouter();
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
    const [commitMode, setCommitMode] = useState<CommitMode>("SAFE_PARTIAL");
    const [preview, setPreview] = useState<Preview | null>(null);
    const [rowDrafts, setRowDrafts] = useState<Record<string, RowDraft>>({});
    const [rowDraftDirty, setRowDraftDirty] = useState<Record<string, Partial<Record<keyof RowDraft, boolean>>>>({});
    const [rowDraftSourceKeys, setRowDraftSourceKeys] = useState<Record<string, string>>({});
    const [rowFeeLinked, setRowFeeLinked] = useState<Record<string, boolean>>({});
    const [rowPreview, setRowPreview] = useState<RowPreview | null>(null);
    const [rowPreviewLoading, setRowPreviewLoading] = useState(false);
    const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
    const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>({ paid: "", unpaid: "", waived: "", defaultMethod: "" });
    const analysisStartedRef = useRef(false);
    const mutationsDisabled = !importDecision.allowed;
    const mutationBlockReason = importDecision.allowed ? null : importDecision.reason;
    const guardMutation = useCallback(() => {
        if (!mutationsDisabled) return true;
        setError(mutationBlockReason ?? "Import changes are unavailable.");
        return false;
    }, [mutationBlockReason, mutationsDisabled]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const nextDetail = await importSessions.detail<ImportDetail>(branchId, sessionId, {
                rowFilter,
                limit: 120,
            });
            setDetail(nextDetail);
            return nextDetail;
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load import session.");
            return null;
        } finally {
            setLoading(false);
        }
    }, [branchId, rowFilter, sessionId]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        if (mutationsDisabled || !detail || detail.status !== "UPLOADED" || analysisStartedRef.current) return;
        analysisStartedRef.current = true;
        setAnalyzing(true);
        setError(null);
        importSessions.analyze<ImportDetail>(branchId, sessionId)
            .then(async () => {
                setPreview(null);
                await load();
            })
            .catch(analyzeError => {
                setError(analyzeError instanceof Error ? analyzeError.message : "Failed to analyze import session.");
            })
            .finally(() => setAnalyzing(false));
    }, [branchId, detail, load, mutationsDisabled, sessionId]);

    useEffect(() => {
        if (mutationsDisabled) setConfirmOpen(false);
    }, [mutationsDisabled]);

    const rows = useMemo(() => detail?.rows ?? [], [detail?.rows]);
    const mapping = useMemo(() => detail?.mapping?.columnMappings ?? [], [detail?.mapping?.columnMappings]);
    const options = detail?.mapping?.importOptions ?? {};
    const branchContext = detail?.branchContext;
    const questions = detail?.questions ?? [];
    const openQuestions = questions.filter(question => question.status === "OPEN");
    const readiness = detail?.summary?.readinessScore ?? 0;
    const selectedRow = rows.find(row => row.id === selectedRowId) ?? rows[0] ?? null;
    const selectedDraft = selectedRow ? rowDrafts[selectedRow.id] : undefined;
    const selectedNormalized = useMemo(
        () => selectedRow && selectedDraft ? normalizedFromImportDraft(selectedRow, selectedDraft, branchContext) : null,
        [branchContext, selectedDraft, selectedRow]
    );
    const selectedNormalizedKey = useMemo(() => JSON.stringify(selectedNormalized), [selectedNormalized]);
    const detectedPaymentValues = useMemo(() => detectedPaymentValuesFrom(detail, rows), [detail, rows]);
    const steps = useMemo(() => buildImportWizardSteps({ detail, preview, commitMode }), [commitMode, detail, preview]);
    const activeIndex = steps.findIndex(step => step.id === activeStep);
    const currentStepIndex = activeIndex >= 0 ? activeIndex : 0;
    const activeStepMeta = steps[currentStepIndex];

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
    }, [branchId, selectedNormalized, selectedNormalizedKey, selectedRow, sessionId]);

    const saveMapping = async (columnMappings: ImportColumnMapping[], importOptions?: Partial<ImportOptions>) => {
        if (!guardMutation()) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await importSessions.updateMapping<ImportDetail>(branchId, sessionId, { columnMappings, importOptions });
            setPreview(null);
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
    };

    const saveSelectedRow = async (overrideNormalizedData?: ImportNormalizedRow) => {
        if (!guardMutation()) return;
        if (!selectedRow || (!selectedDraft && !overrideNormalizedData)) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            const normalizedData = overrideNormalizedData ?? normalizedFromImportDraft(selectedRow, selectedDraft as RowDraft, branchContext);
            await importSessions.updateRows<ImportDetail>(branchId, sessionId, {
                edits: [{ rowId: selectedRow.id, normalizedData }],
            });
            setPreview(null);
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
        } catch (rowError) {
            setError(rowError instanceof Error ? rowError.message : "Failed to save row.");
        } finally {
            setSaving(false);
        }
    };

    const skipSelectedRow = async () => {
        if (!guardMutation()) return;
        if (!selectedRow) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await importSessions.updateRows<ImportDetail>(branchId, sessionId, selectedRow.skipped
                ? { unskipRowIds: [selectedRow.id] }
                : { skipRowIds: [selectedRow.id] });
            setPreview(null);
            setNotice(selectedRow.skipped ? "Row restored to the review queue." : "Row skipped for this import.");
            await load();
        } catch (rowError) {
            setError(rowError instanceof Error ? rowError.message : "Failed to update row.");
        } finally {
            setSaving(false);
        }
    };

    const answerQuestion = async (questionId: string, answer: unknown) => {
        if (!guardMutation()) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await importSessions.answerQuestion<ImportDetail>(branchId, sessionId, {
                questionId,
                answer,
                applyToAffectedRows: true,
            });
            setPreview(null);
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
        setSaving(true);
        setError(null);
        try {
            const nextPage = await importSessions.detail<ImportDetail>(branchId, sessionId, {
                rowFilter,
                limit: 120,
                cursor: detail.rowPage.nextCursor,
            });
            setDetail(prev => prev ? {
                ...nextPage,
                rows: [...prev.rows, ...nextPage.rows],
            } : nextPage);
        } catch (loadMoreError) {
            setError(loadMoreError instanceof Error ? loadMoreError.message : "Failed to load more rows.");
        } finally {
            setSaving(false);
        }
    };

    const loadPreview = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            setPreview(await importSessions.preview<Preview>(branchId, sessionId, commitMode));
        } catch (previewError) {
            setError(previewError instanceof Error ? previewError.message : "Failed to load final preview.");
        } finally {
            setSaving(false);
        }
    }, [branchId, commitMode, sessionId]);

    const commit = async () => {
        if (!guardMutation()) {
            setConfirmOpen(false);
            return;
        }
        if (!preview?.planVersion) {
            setConfirmOpen(false);
            setError("Refresh the final preview before importing.");
            setActiveStep("preview");
            return;
        }
        const planVersion = preview.planVersion;
        const mode = commitMode;
        const plannedStudents = preview.summary.createStudents;
        const plannedSkipped = preview.summary.blockedRows + preview.summary.skippedRows;

        setSaving(true);
        setError(null);
        setNotice(`Importing ${plannedStudents} student${plannedStudents === 1 ? "" : "s"}${plannedSkipped > 0 ? ` and leaving ${plannedSkipped} row${plannedSkipped === 1 ? "" : "s"} staged` : ""}.`);
        setConfirmOpen(false);
        try {
            const result = await importSessions.commit<CommitResponse>(branchId, sessionId, planVersion, mode);
            setPreview(null);
            const refreshedDetail = await load();
            if (!refreshedDetail) {
                setDetail(prev => prev ? {
                    ...prev,
                    status: sessionStatusFromCommit(result.status),
                    commits: [{
                        status: result.status,
                        summary: result.summary ?? {},
                        errors: result.errors ?? [],
                        createdAt: new Date().toISOString(),
                    }, ...(prev.commits ?? [])],
                } : prev);
            }
            setActiveStep("result");
            if (result.status === "FAILED") {
                setError("Import failed. Review the result details below before trying again.");
                setNotice(null);
            } else if (!refreshedDetail) {
                setError("Import finished, but the result report could not refresh. Use Refresh session to reload the saved report.");
                setNotice(null);
            } else {
                const createdStudents = result.summary?.createdStudents ?? plannedStudents;
                setNotice(`Import finished. ${createdStudents} student${createdStudents === 1 ? "" : "s"} created.`);
            }
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

    const goNext = () => {
        const next = steps[Math.min(currentStepIndex + 1, steps.length - 1)];
        if (next) setActiveStep(next.id);
    };

    const goBackStep = () => {
        const previous = steps[Math.max(currentStepIndex - 1, 0)];
        if (previous) setActiveStep(previous.id);
    };

    if (!detail && loading) {
        return (
            <PageShell>
                <div className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
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
                    {detail?.status && <Badge variant={statusTone(detail.status)}>{labelImportStatus(detail.status)}</Badge>}
                    <AppButton variant="quiet" icon={ArrowLeft} onClick={() => router.push(`/branch/${branchId}/onboarding/import`)}>
                        Back
                    </AppButton>
                </div>
            </div>

            {error && (
                <div className="rounded-[8px] border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
                    {error}
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
                <div className="rounded-[8px] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-3 text-sm text-[color:var(--ui-badge-cyan-text)]">
                    {notice}
                </div>
            )}

            {analyzing && (
                <div className="flex items-center gap-3 rounded-[8px] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] p-3 text-sm text-[color:var(--ui-badge-cyan-text)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Analyzing source data. Manual fallback remains available if AI is unavailable.
                </div>
            )}

            {detail && (
                <>
                    <AppPanel contentClassName="space-y-4">
                        <div className="grid gap-3 md:grid-cols-5">
                            <Metric label="Readiness" value={`${readiness}%`} tone={readiness >= 80 ? "success" : readiness >= 50 ? "warning" : "danger"} />
                            <Metric label="Ready" value={detail.summary?.readyRows ?? 0} tone="success" />
                            <Metric label="Review" value={(detail.summary?.needsReviewRows ?? 0) + (detail.summary?.duplicateRows ?? 0)} tone={(detail.summary?.needsReviewRows ?? 0) + (detail.summary?.duplicateRows ?? 0) > 0 ? "warning" : "success"} />
                            <Metric label="Blocked" value={(detail.summary?.blockedRows ?? 0) + (detail.summary?.conflictRows ?? 0)} tone={(detail.summary?.blockedRows ?? 0) + (detail.summary?.conflictRows ?? 0) > 0 ? "danger" : "success"} />
                            <Metric label="Questions" value={openQuestions.length} tone={openQuestions.length > 0 ? "warning" : "success"} />
                        </div>
                        <div className={pageProgressTrackClass}>
                            <div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: `${Math.max(0, Math.min(100, readiness))}%` }} />
                        </div>
                        <div className="grid gap-2 md:grid-cols-6">
                            {steps.map((step, index) => (
                                <button
                                    key={step.id}
                                    type="button"
                                    onClick={() => setActiveStep(step.id)}
                                    className={cn(
                                        "min-h-24 rounded-[8px] border p-3 text-left transition-colors hover:bg-white/[0.04]",
                                        activeStep === step.id
                                            ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]"
                                            : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)]"
                                    )}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <Badge variant={step.state === "completed" ? "success" : step.state === "needs_attention" ? "warning" : "default"}>
                                            {index + 1}
                                        </Badge>
                                        {typeof step.count === "number" && <span className={cn("text-xs", pageSubtleTextClass)}>{step.count}</span>}
                                    </div>
                                    <p className="mt-2 text-sm font-semibold text-[color:var(--text-primary)]">{step.label}</p>
                                    <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>{step.detail}</p>
                                </button>
                            ))}
                        </div>
                    </AppPanel>

                    {activeStep === "columns" && (
                        <ColumnsStep
                            detail={detail}
                            saving={saving}
                            mutationsDisabled={mutationsDisabled}
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
                            onFilterChange={filter => {
                                setRowFilter(filter);
                                setSelectedRowId(null);
                            }}
                            onSelectRow={setSelectedRowId}
                            onLoadMore={loadMoreRows}
                            onDraftChange={updateRowDraft}
                            onFeeLinkChange={updateRowFeeLink}
                            feeLinked={selectedRow ? Boolean(rowFeeLinked[selectedRow.id]) : false}
                            onSaveRow={() => saveSelectedRow()}
                            onResetRow={resetSelectedDraft}
                            onSkipRow={skipSelectedRow}
                            onImportStudentOnly={() => {
                                if (selectedRow && selectedDraft) {
                                    saveSelectedRow(studentOnlyNormalizedData(normalizedFromImportDraft(selectedRow, selectedDraft, branchContext)));
                                }
                            }}
                        />
                    )}

                    {activeStep === "decisions" && (
                        <DecisionsStep
                            questions={questions}
                            questionDrafts={questionDrafts}
                            saving={saving}
                            mutationsDisabled={mutationsDisabled}
                            onDraftChange={(questionId, value) => setQuestionDrafts(prev => ({ ...prev, [questionId]: value }))}
                            onAnswer={answerQuestion}
                            onDeferAllocations={() => updateOption(deferAllocationOptions())}
                            onStudentsOnly={() => updateOption(studentsOnlyImportOptions())}
                        />
                    )}

                    {activeStep === "payments" && (
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
                            preview={preview}
                            importOptions={options}
                            commitMode={commitMode}
                            saving={saving}
                            mutationsDisabled={mutationsDisabled}
                            onModeChange={mode => {
                                setCommitMode(mode);
                                setPreview(null);
                            }}
                            onRefreshPreview={loadPreview}
                            onConfirmImport={() => {
                                if (guardMutation()) setConfirmOpen(true);
                            }}
                        />
                    )}

                    {activeStep === "result" && (
                        <ResultStep
                            branchId={branchId}
                            detail={detail}
                            onGoPreview={() => setActiveStep("preview")}
                        />
                    )}

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <AppButton variant="quiet" icon={RotateCcw} onClick={load} isLoading={loading}>
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
                        description="This creates branch records from the refreshed final plan. Safe partial imports ready rows and leaves blocked rows in the workspace."
                        confirmText={commitMode === "SAFE_PARTIAL" ? "Import ready rows" : "Import all rows"}
                    />
                </>
            )}
        </PageShell>
    );
}
