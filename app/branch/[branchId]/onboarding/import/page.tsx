"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, FileSpreadsheet, FileText, ReceiptText, Sofa, TableProperties, UploadCloud, UsersRound } from "lucide-react";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { AppButton, AppPanel, AppSelect, ErrorState, PageShell } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import {
    ImportSessionApiError,
    importSessions,
    type CreateImportSessionResponse,
    type ImportRunStartResponse,
    type WorkbookSelectionDetails,
} from "@/lib/api/importSessions";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import { cn } from "@/lib/utils";
import type { ImportSessionListItem } from "@/importing/contracts/import-session.contract";
import type { CapabilityDecision } from "@/types";
import { labelImportStatus, statusTone } from "@/importing/utils/import-wizard-view-model";
import { MAX_IMPORT_ROWS } from "@/importing/constants/import-limits";
import {
    pageDescriptionClass,
    pageEyebrowClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageTableBodyDividerClass,
    pageTitleClass,
} from "@/components/ui/pageSurface";

const supportedFormats = ["CSV", "XLSX", "XLS", "PDF", "Pasted table"];
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_REQUEST_BYTES = Math.floor(4.25 * 1024 * 1024);
type ImportGoal = "STUDENTS" | "STUDENTS_ALLOCATIONS" | "FULL";
type ImportSourceMode = "file" | "paste";
type WorkbookReview = {
    workbook: WorkbookSelectionDetails;
    sheetName: string;
    headerRow: number | null;
};

function workbookReviewFrom(error: unknown): WorkbookReview | null {
    if (!(error instanceof ImportSessionApiError) || error.code !== "IMPORT_WORKBOOK_SELECTION_REQUIRED") return null;
    const workbook = error.details.workbook;
    if (!workbook || typeof workbook !== "object" || Array.isArray(workbook) || !("sheets" in workbook) || !Array.isArray(workbook.sheets)) return null;
    const details = workbook as WorkbookSelectionDetails;
    const firstSheet = details.sheets[0];
    if (!firstSheet) return null;
    return {
        workbook: details,
        sheetName: firstSheet.name,
        headerRow: firstSheet.suggestedHeaderRow ?? firstSheet.headerCandidates[0]?.rowNumber ?? null,
    };
}

function extractionPreviewCells(row: Record<string, unknown> | unknown[]) {
    if (Array.isArray(row)) return row.map(value => String(value ?? ""));
    return Object.entries(row).map(([key, value]) => `${key}: ${String(value ?? "")}`);
}

function importSessionHref(branchId: string, goal: ImportGoal, created: Pick<CreateImportSessionResponse, "sessionId" | "runId">) {
    const query = new URLSearchParams({ goal });
    if (created.runId) query.set("runId", created.runId);
    return `/branch/${branchId}/onboarding/import/${created.sessionId}?${query.toString()}`;
}

const importGoals: Array<{
    id: ImportGoal;
    title: string;
    description: string;
    detail: string;
    icon: typeof UsersRound;
    recommended?: boolean;
}> = [
    {
        id: "STUDENTS",
        title: "Students",
        description: "Names, phones, joined dates, and monthly fees.",
        detail: "Fastest start. Add seats and payments later.",
        icon: UsersRound,
        recommended: true,
    },
    {
        id: "STUDENTS_ALLOCATIONS",
        title: "Students + seats",
        description: "Students, shifts, bundles, and seat allocations.",
        detail: "Payment history stays out of this import.",
        icon: Sofa,
    },
    {
        id: "FULL",
        title: "Full import",
        description: "Students, allocations, and payment information.",
        detail: "Best when payment status is clear and reviewed.",
        icon: ReceiptText,
    },
];

function goalLabel(goal: ImportGoal | undefined | null) {
    if (goal === "STUDENTS_ALLOCATIONS") return "Students + seats";
    if (goal === "FULL") return "Full import";
    return "Students";
}

function validateFile(file: File) {
    const supported = [".csv", ".xlsx", ".xls", ".pdf"].some(extension => file.name.toLowerCase().endsWith(extension));
    if (!supported) return "Choose a CSV, XLSX, XLS, or PDF file.";
    if (file.size > MAX_IMPORT_BYTES) return "This file is larger than 4 MiB. Split it into smaller imports and try again.";
    return null;
}

function pastedRequestByteLength(pastedTable: string, goal: ImportGoal) {
    return new TextEncoder().encode(JSON.stringify({
        pastedTable,
        fileName: "Pasted table",
        goal,
    })).byteLength;
}

function downloadSampleTemplate(branchId: string, goal: ImportGoal) {
    const link = document.createElement("a");
    link.href = `/api/branches/${encodeURIComponent(branchId)}/import-sessions/template?goal=${goal}&format=xlsx`;
    link.click();
}

export default function ImportAssistantPage({ params }: { params: Promise<{ branchId: string }> }) {
    const { branchId } = use(params);

    return (
        <BranchAccessGuard branchId={branchId} permission="students">
            {access => (
                <ImportAssistantContent
                    branchId={branchId}
                    importDecision={getBranchCapabilityDecision(access, "importStudents")}
                />
            )}
        </BranchAccessGuard>
    );
}

function ImportAssistantContent({
    branchId,
    importDecision,
}: {
    branchId: string;
    importDecision: CapabilityDecision;
}) {
    const router = useRouter();
    const { formatDateTime, formatNumber } = useUserPreferences();
    const [goal, setGoal] = useState<ImportGoal>("STUDENTS");
    const [sourceMode, setSourceMode] = useState<ImportSourceMode>("file");
    const [file, setFile] = useState<File | null>(null);
    const [pastedTable, setPastedTable] = useState("");
    const [workbookReview, setWorkbookReview] = useState<WorkbookReview | null>(null);
    const [pdfReview, setPdfReview] = useState<CreateImportSessionResponse | null>(null);
    const [pdfAccepted, setPdfAccepted] = useState(false);
    const [sessions, setSessions] = useState<ImportSessionListItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingSessions, setLoadingSessions] = useState(true);
    const [sessionsError, setSessionsError] = useState<string | null>(null);
    const [sessionsReloadKey, setSessionsReloadKey] = useState(0);
    const workbookReviewRef = useRef<HTMLFieldSetElement>(null);
    const pdfReviewRef = useRef<HTMLDivElement>(null);

    const pastedRowEstimate = useMemo(
        () => Math.max(0, pastedTable.trim().split(/\r?\n/).filter(Boolean).length - 1),
        [pastedTable]
    );
    const pastedRequestBytes = useMemo(() => pastedRequestByteLength(pastedTable, goal), [goal, pastedTable]);
    const workbookReady = !workbookReview || Boolean(workbookReview.sheetName && workbookReview.headerRow);
    const canUpload = (sourceMode === "file" ? Boolean(file) && workbookReady : Boolean(pastedTable.trim())) && !pdfReview;
    const mutationsDisabled = !importDecision.allowed;
    const mutationBlockReason = importDecision.allowed ? null : importDecision.reason;

    useEffect(() => {
        let alive = true;
        setLoadingSessions(true);
        setSessionsError(null);
        setSessions([]);
        importSessions.list(branchId)
            .then(value => {
                if (alive) setSessions(value as ImportSessionListItem[]);
            })
            .catch(loadError => {
                if (alive) {
                    setSessionsError(loadError instanceof Error ? loadError.message : "Import history could not be loaded.");
                }
            })
            .finally(() => {
                if (alive) setLoadingSessions(false);
            });

        return () => {
            alive = false;
        };
    }, [branchId, sessionsReloadKey]);

    useEffect(() => {
        if (workbookReview?.workbook) workbookReviewRef.current?.focus();
        else if (pdfReview?.sessionId) pdfReviewRef.current?.focus();
    }, [pdfReview?.sessionId, workbookReview?.workbook]);

    const upload = async () => {
        if (!importDecision.allowed) {
            setError(importDecision.reason);
            return;
        }
        if (!canUpload) return;
        if (sourceMode === "file" && file) {
            const fileError = validateFile(file);
            if (fileError) {
                setError(fileError);
                return;
            }
        }
        if (sourceMode === "paste" && pastedRowEstimate > MAX_IMPORT_ROWS) {
            setError(`This table appears to contain ${formatNumber(pastedRowEstimate)} rows. Split it into imports of ${formatNumber(MAX_IMPORT_ROWS)} rows or fewer.`);
            return;
        }
        if (sourceMode === "paste" && pastedRequestBytes > MAX_IMPORT_REQUEST_BYTES) {
            setError("This pasted table would exceed the 4.25 MiB request limit after safe JSON encoding. Split it into smaller imports and try again.");
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const created = sourceMode === "file" && file
                ? await importSessions.createFromFile(branchId, file, goal, workbookReview ? {
                    sheetName: workbookReview.sheetName,
                    headerRow: workbookReview.headerRow ?? undefined,
                } : undefined)
                : await importSessions.createFromPastedTable(branchId, pastedTable, goal);
            if (created.requiresPdfConfirmation) {
                setPdfReview(created);
                setPdfAccepted(false);
                return;
            }
            router.push(importSessionHref(branchId, goal, created));
        } catch (uploadError) {
            const workbook = workbookReviewFrom(uploadError);
            if (workbook) {
                setWorkbookReview(workbook);
                setError("Choose the worksheet and header row, then continue with the same file.");
            } else {
                setError(uploadError instanceof Error ? uploadError.message : "Import upload failed.");
            }
        } finally {
            setLoading(false);
        }
    };

    const confirmPdfExtraction = async () => {
        if (!pdfReview || !pdfAccepted || !importDecision.allowed) return;
        setLoading(true);
        setError(null);
        try {
            const started = await importSessions.analyze<ImportRunStartResponse>(branchId, pdfReview.sessionId, {
                confirmPdfExtraction: true,
            });
            router.push(importSessionHref(branchId, goal, {
                sessionId: pdfReview.sessionId,
                runId: started.runId,
            }));
        } catch (confirmationError) {
            setError(confirmationError instanceof Error ? confirmationError.message : "PDF extraction could not be confirmed.");
        } finally {
            setLoading(false);
        }
    };

    const chooseFile = (nextFile: File | null) => {
        setError(null);
        setWorkbookReview(null);
        setPdfReview(null);
        setPdfAccepted(false);
        if (!nextFile) {
            setFile(null);
            return;
        }
        const fileError = validateFile(nextFile);
        if (fileError) {
            setFile(null);
            setError(fileError);
            return;
        }
        setPastedTable("");
        setFile(nextFile);
    };

    return (
        <PageShell>
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className={pageEyebrowClass}>Data onboarding</p>
                        <h1 className={pageTitleClass}>Import assistant</h1>
                        <p className={pageDescriptionClass}>
                            Upload a spreadsheet or paste a table. AI can help with column suggestions, but manual review always works.
                        </p>
                    </div>
                    <AppButton variant="quiet" icon={ArrowLeft} onClick={() => router.push(`/branch/${branchId}`)}>
                        Skip import
                    </AppButton>
                </div>

                {mutationBlockReason && importDecision.blocker !== "permission" && (
                    <div id="import-mutation-blocker" className="flex flex-col gap-2 rounded-[8px] border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between" role="status">
                        <span>Import changes are disabled. {mutationBlockReason}</span>
                        {importDecision.recoveryHref ? (
                            <Link href={importDecision.recoveryHref} className="shrink-0 font-semibold underline underline-offset-4">
                                Resolve access
                            </Link>
                        ) : null}
                    </div>
                )}

                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
                    {importDecision.blocker !== "permission" ? <AppPanel
                        title="1. Choose what to import"
                        description="Start small or bring the full history. You can add deferred information later."
                    >
                        <fieldset>
                            <legend className="sr-only">Import goal</legend>
                            <div className="grid gap-3 lg:grid-cols-3">
                                {importGoals.map(option => {
                                    const selected = goal === option.id;
                                    const GoalIcon = option.icon;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            aria-pressed={selected}
                                            disabled={loading || Boolean(pdfReview)}
                                            onClick={() => setGoal(option.id)}
                                            className={cn(
                                                "flex min-h-40 flex-col items-start rounded-[8px] border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60",
                                                selected
                                                    ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]"
                                                    : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] hover:bg-white/[0.04]"
                                            )}
                                        >
                                            <span className="flex w-full items-start justify-between gap-3">
                                                <span className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-cyan-400/10 text-cyan-300">
                                                    <GoalIcon size={19} />
                                                </span>
                                                {option.recommended && <Badge variant="success">Recommended</Badge>}
                                            </span>
                                            <span className="mt-4 text-sm font-semibold text-[color:var(--text-primary)]">{option.title}</span>
                                            <span className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>{option.description}</span>
                                            <span className="mt-auto pt-3 text-xs font-medium text-cyan-200">{option.detail}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </fieldset>

                        <div className="mt-6 border-t border-[color:var(--ui-form-section-divider)] pt-5">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">2. Add your data</p>
                                    <p className={cn("mt-1 text-xs", pageMutedTextClass)}>Choose one source. Nothing is created until the final review.</p>
                                </div>
                                <div className="inline-flex rounded-[8px] border border-[color:var(--ui-form-surface-border)] p-1" role="group" aria-label="Import source">
                                    <button
                                        type="button"
                                        aria-pressed={sourceMode === "file"}
                                        disabled={loading || Boolean(pdfReview)}
                                        onClick={() => { setSourceMode("file"); setPastedTable(""); setWorkbookReview(null); setPdfReview(null); setError(null); }}
                                        className={cn("rounded-[6px] px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60", sourceMode === "file" ? "bg-cyan-400/15 text-cyan-100" : pageMutedTextClass)}
                                    >
                                        Upload file
                                    </button>
                                    <button
                                        type="button"
                                        aria-pressed={sourceMode === "paste"}
                                        disabled={loading || Boolean(pdfReview)}
                                        onClick={() => { setSourceMode("paste"); setFile(null); setWorkbookReview(null); setPdfReview(null); setError(null); }}
                                        className={cn("rounded-[6px] px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60", sourceMode === "paste" ? "bg-cyan-400/15 text-cyan-100" : pageMutedTextClass)}
                                    >
                                        Paste table
                                    </button>
                                </div>
                            </div>

                            {sourceMode === "file" ? (
                                <div
                                    className={cn("mt-4 flex min-h-52 flex-col items-center justify-center gap-4 rounded-[8px] border border-dashed p-6 text-center", pageInsetSurfaceClass)}
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        if (mutationsDisabled || loading || pdfReview) return;
                                        chooseFile(event.dataTransfer.files?.[0] ?? null);
                                    }}
                                >
                                    <div className="flex h-12 w-12 items-center justify-center rounded-[8px] bg-cyan-400/10 text-cyan-300"><UploadCloud size={22} /></div>
                                    <div>
                                        <p className="break-all text-sm font-semibold text-[color:var(--text-primary)]">{file ? file.name : "Drop a file here"}</p>
                                        <p className={cn("mt-1 text-xs", pageMutedTextClass)}>{file ? `${(file.size / 1024).toFixed(1)} KiB selected` : "CSV, XLSX, XLS, or PDF up to 4 MiB"}</p>
                                    </div>
                                    <div className="flex flex-wrap justify-center gap-2">
                                        <label className={cn("inline-flex", mutationsDisabled || loading || pdfReview ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
                                            <input type="file" className="sr-only" accept=".csv,.xlsx,.xls,.pdf" disabled={mutationsDisabled || loading || Boolean(pdfReview)} aria-describedby="import-source-limits" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
                                            <span className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] px-3 py-2 text-sm font-semibold text-[color:var(--ui-button-secondary-text)]">Choose file</span>
                                        </label>
                                        {file && <AppButton size="sm" variant="quiet" onClick={() => chooseFile(null)} disabled={loading || Boolean(pdfReview)}>Clear</AppButton>}
                                    </div>
                                </div>
                            ) : (
                                <label className="mt-4 block space-y-2">
                                    <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]"><TableProperties className="h-4 w-4 text-cyan-300" />Paste rows with a header</span>
                                    <textarea
                                        value={pastedTable}
                                        onChange={(event) => { setPastedTable(event.target.value); setError(null); }}
                                        rows={10}
                                        disabled={mutationsDisabled || loading}
                                        aria-describedby="import-source-limits import-paste-count"
                                        placeholder="Name\tMobile\tSeat No\tShift\tFee\tPaid"
                                        className="min-h-52 w-full rounded-[8px] border border-[color:var(--ui-form-field-border)] bg-[color:var(--ui-form-field-bg)] p-3 text-sm text-[color:var(--text-primary)] outline-none focus:border-[color:var(--ui-form-field-focus-border)] disabled:cursor-not-allowed disabled:opacity-60"
                                    />
                                    <span id="import-paste-count" className={cn("block text-xs", pastedRowEstimate > MAX_IMPORT_ROWS ? "text-red-300" : pageMutedTextClass)}>
                                        About {formatNumber(pastedRowEstimate)} data rows detected · {formatNumber(pastedRequestBytes)} encoded bytes
                                    </span>
                                </label>
                            )}

                            {sourceMode === "file" && workbookReview && (() => {
                                const selectedSheet = workbookReview.workbook.sheets.find(sheet => sheet.name === workbookReview.sheetName);
                                return (
                                    <fieldset ref={workbookReviewRef} tabIndex={-1} className={cn("mt-4 space-y-4 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]", pageInsetSurfaceClass)}>
                                        <legend className="px-1 text-sm font-semibold text-[color:var(--text-primary)]">Choose worksheet headings</legend>
                                        <p className={cn("text-xs leading-5", pageMutedTextClass)}>
                                            The workbook has multiple possible tables. Select the worksheet and the row containing column names; the same file will be resubmitted.
                                        </p>
                                        <div className="grid gap-4 sm:grid-cols-3">
                                            <label className="space-y-2">
                                                <span className="text-xs font-semibold text-[color:var(--text-secondary)]">Worksheet</span>
                                                <AppSelect
                                                    value={workbookReview.sheetName}
                                                    disabled={loading}
                                                    onValueChange={sheetName => {
                                                        const sheet = workbookReview.workbook.sheets.find(candidate => candidate.name === sheetName);
                                                        setWorkbookReview(current => current ? {
                                                            ...current,
                                                            sheetName,
                                                            headerRow: sheet?.suggestedHeaderRow ?? sheet?.headerCandidates[0]?.rowNumber ?? null,
                                                        } : current);
                                                    }}
                                                    options={workbookReview.workbook.sheets.map(sheet => ({
                                                        value: sheet.name,
                                                        label: sheet.name,
                                                        description: `${sheet.populatedRows} populated rows, ${sheet.columnCount} columns`,
                                                    }))}
                                                />
                                            </label>
                                            <label className="space-y-2">
                                                <span className="text-xs font-semibold text-[color:var(--text-secondary)]">Suggested header row</span>
                                                <AppSelect
                                                    value={(selectedSheet?.headerCandidates ?? []).some(candidate => candidate.rowNumber === workbookReview.headerRow)
                                                        ? String(workbookReview.headerRow)
                                                        : ""}
                                                    disabled={loading}
                                                    onValueChange={value => setWorkbookReview(current => current ? { ...current, headerRow: Number(value) } : current)}
                                                    options={(selectedSheet?.headerCandidates ?? []).map(candidate => ({
                                                        value: String(candidate.rowNumber),
                                                        label: `Row ${candidate.rowNumber}`,
                                                        description: candidate.values.filter(Boolean).slice(0, 4).join(" · ") || "Blank row",
                                                    }))}
                                                    placeholder="Choose header row"
                                                />
                                            </label>
                                            <label className="space-y-2">
                                                <span className="text-xs font-semibold text-[color:var(--text-secondary)]">Header row number</span>
                                                <input
                                                    type="number"
                                                    inputMode="numeric"
                                                    min={1}
                                                    step={1}
                                                    value={workbookReview.headerRow ?? ""}
                                                    disabled={loading}
                                                    onChange={event => {
                                                        const value = event.target.valueAsNumber;
                                                        setWorkbookReview(current => current ? {
                                                            ...current,
                                                            headerRow: Number.isInteger(value) && value > 0 ? value : null,
                                                        } : current);
                                                    }}
                                                    aria-describedby="workbook-header-row-help"
                                                    className="min-h-11 w-full rounded-[8px] border border-[color:var(--ui-form-field-border)] bg-[color:var(--ui-form-field-bg)] px-3 py-2 text-sm text-[color:var(--text-primary)] outline-none focus:border-[color:var(--ui-form-field-focus-border)] disabled:cursor-not-allowed disabled:opacity-60"
                                                />
                                                <span id="workbook-header-row-help" className={cn("block text-xs leading-5", pageMutedTextClass)}>
                                                    Enter any row number when the heading row is not in the suggestions.
                                                </span>
                                            </label>
                                        </div>
                                        {selectedSheet && (
                                            <div className="overflow-x-auto rounded-[8px] border border-[color:var(--ui-table-border)]" tabIndex={0} aria-label="Header row candidates">
                                                <table className="w-full min-w-[520px] text-left text-xs">
                                                    <caption className="sr-only">Candidate header rows for {selectedSheet.name}</caption>
                                                    <thead><tr><th scope="col" className="p-3">Row</th><th scope="col" className="p-3">Detected headings</th></tr></thead>
                                                    <tbody>
                                                        {selectedSheet.headerCandidates.map(candidate => (
                                                            <tr key={candidate.rowNumber} className="border-t border-[color:var(--ui-table-border)]">
                                                                <th scope="row" className="p-3">{candidate.rowNumber}</th>
                                                                <td className="p-3 text-[color:var(--text-secondary)]">{candidate.values.filter(Boolean).join(" · ") || "Blank"}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                    </fieldset>
                                );
                            })()}

                            {pdfReview && (
                                <div ref={pdfReviewRef} tabIndex={-1} className={cn("mt-4 space-y-4 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]", pageInsetSurfaceClass)} role="region" aria-labelledby="pdf-extraction-review-title">
                                    <div>
                                        <h3 id="pdf-extraction-review-title" className="text-sm font-semibold text-[color:var(--text-primary)]">Review PDF extraction</h3>
                                        <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>
                                            PDF tables are beta. Compare this extracted sample with the source document before analysis starts.
                                        </p>
                                    </div>
                                    <div className="overflow-x-auto rounded-[8px] border border-[color:var(--ui-table-border)]" tabIndex={0} aria-label="PDF extraction preview">
                                        <table className="w-full min-w-[520px] text-left text-xs">
                                            <caption className="sr-only">Extracted PDF sample rows</caption>
                                            <tbody>
                                                {(pdfReview.extractionPreview ?? []).slice(0, 8).map((row, index) => (
                                                    <tr key={index} className="border-t border-[color:var(--ui-table-border)] first:border-t-0">
                                                        <th scope="row" className="w-16 p-3">{index + 1}</th>
                                                        <td className="p-3 text-[color:var(--text-secondary)]">{extractionPreviewCells(row).join(" · ") || "Empty row"}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <label className="flex items-start gap-3 text-sm text-[color:var(--text-primary)]">
                                        <input
                                            type="checkbox"
                                            checked={pdfAccepted}
                                            disabled={loading || mutationsDisabled}
                                            onChange={event => setPdfAccepted(event.target.checked)}
                                            className="mt-0.5 h-4 w-4"
                                        />
                                        <span>I reviewed the sample and confirm that the extracted columns and rows match the PDF.</span>
                                    </label>
                                    <div className="flex flex-wrap gap-2">
                                        <AppButton variant="primary" onClick={confirmPdfExtraction} disabled={!pdfAccepted || mutationsDisabled} isLoading={loading}>
                                            Confirm and analyze PDF
                                        </AppButton>
                                        <AppButton variant="secondary" onClick={() => chooseFile(null)} disabled={loading}>
                                            Choose a different file
                                        </AppButton>
                                    </div>
                                </div>
                            )}

                            <div id="import-source-limits" className={cn("mt-4 grid gap-2 text-xs sm:grid-cols-3", pageMutedTextClass)}>
                                <span>Maximum file size: 4 MiB</span>
                                <span>Maximum rows: {formatNumber(MAX_IMPORT_ROWS)}</span>
                                <span>PDF beta: text-based tables only; scans may not read correctly</span>
                            </div>
                        </div>

                        {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}

                        <div className="mt-5 flex flex-wrap gap-3">
                            <AppButton
                                variant="primary"
                                icon={UploadCloud}
                                onClick={upload}
                                disabled={!canUpload || mutationsDisabled}
                                aria-describedby={mutationsDisabled ? "import-mutation-blocker" : undefined}
                                isLoading={loading}
                            >
                                {workbookReview ? "Continue with selected worksheet" : "Upload and review " + goalLabel(goal).toLowerCase()}
                            </AppButton>
                            <AppButton variant="secondary" icon={FileSpreadsheet} onClick={() => downloadSampleTemplate(branchId, goal)}>
                                Download {goalLabel(goal)} Excel template
                            </AppButton>
                            <AppButton variant="quiet" onClick={() => router.push(`/branch/${branchId}`)}>
                                Continue without import
                            </AppButton>
                        </div>
                    </AppPanel> : null}

                    <div className="space-y-5">
                        <AppPanel title="What happens next" description="Upload, fix only what needs attention, then review the exact import plan.">
                            <div className="flex flex-wrap gap-2">
                                {supportedFormats.map(format => <Badge key={format} variant="cyan">{format}</Badge>)}
                            </div>
                            <div className="mt-5 space-y-3 text-sm text-[color:var(--text-secondary)]">
                                <div className="flex gap-3">
                                    <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                                    <span>Your source stays in a review workspace until you explicitly confirm the import.</span>
                                </div>
                                <div className="flex gap-3">
                                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                                    <span>AI suggestions are optional. Every field can be reviewed and corrected manually.</span>
                                </div>
                            </div>
                        </AppPanel>

                        <AppPanel title="Recent imports" description="Resume a previous staging workspace." contentClassName="p-0">
                            {loadingSessions ? (
                                <p className={cn("p-4 text-sm", pageMutedTextClass)} role="status">Loading sessions...</p>
                            ) : sessionsError ? (
                                <ErrorState
                                    className="m-4 min-h-40"
                                    title="Import history unavailable"
                                    description={sessionsError}
                                    retryLabel="Retry history"
                                    onRetry={() => setSessionsReloadKey(key => key + 1)}
                                />
                            ) : sessions.length === 0 ? (
                                <p className={cn("p-4 text-sm", pageMutedTextClass)}>No import sessions yet.</p>
                            ) : (
                                <div className={pageTableBodyDividerClass}>
                                    {sessions.slice(0, 8).map(session => {
                                        const sessionGoal = (session as ImportSessionListItem & { goal?: ImportGoal | null }).goal ?? "STUDENTS";
                                        const readiness = session.summary?.readinessScore ?? 0;
                                        const finished = ["COMMITTED", "PARTIAL", "FAILED"].includes(session.status);
                                        return (
                                            <button
                                                key={session.id}
                                                type="button"
                                                onClick={() => router.push(`/branch/${branchId}/onboarding/import/${session.id}?goal=${sessionGoal}`)}
                                                className="block w-full p-4 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-focus-ring)]"
                                                aria-label={`${finished ? "Review" : "Resume"} ${session.fileName ?? session.sourceType}`}
                                            >
                                                <span className="flex items-start justify-between gap-3">
                                                    <span className="min-w-0">
                                                        <span className="block truncate text-sm font-semibold text-[color:var(--text-primary)]">{session.fileName ?? session.sourceType}</span>
                                                        <span className={cn("mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", pageMutedTextClass)}>
                                                            <span>{goalLabel(sessionGoal)}</span>
                                                            <span>{formatNumber(session.summary?.totalRows ?? 0)} rows</span>
                                                            <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" />{formatDateTime(session.updatedAt)}</span>
                                                        </span>
                                                    </span>
                                                    <Badge variant={statusTone(session.status)}>{labelImportStatus(session.status)}</Badge>
                                                </span>
                                                <span className="mt-3 flex items-center gap-3">
                                                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Import readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readiness}>
                                                        <span className="block h-full rounded-full bg-cyan-300" style={{ width: `${Math.max(0, Math.min(100, readiness))}%` }} />
                                                    </span>
                                                    <span className="text-xs font-semibold text-cyan-200">{finished ? "Review result" : "Resume"}</span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </AppPanel>
                    </div>
                </div>
            </PageShell>
    );
}
