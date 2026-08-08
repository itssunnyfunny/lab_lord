import { Loader2, Pencil, RotateCcw, Save, UserRoundCheck } from "lucide-react";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { importRowFieldValue } from "@/importing/utils/manual-row-draft";
import { pageInsetSurfaceClass, pageMutedTextClass, pageTableBodyDividerClass, pageTableHeadClass, pageTableRowClass } from "@/components/ui/pageSurface";
import { pickerSectionLabelClass } from "@/components/ui/pickerSurface";
import { AccessibleTableScroll, formatAmount, importFieldClass, importOptionClass, importSelectClass, IssueList, rowFilterLabels, StatusBadge } from "./shared";
import { CompactImportAllocationPicker } from "./CompactImportAllocationPicker";
import type { ImportDetail, ImportRow, RowDraft, RowFilter, RowPreview } from "./types";

type RowsStepProps = {
    branchId: string;
    sessionId: string;
    detail: ImportDetail;
    rows: ImportRow[];
    rowFilter: RowFilter;
    selectedRow: ImportRow | null;
    selectedDraft?: RowDraft;
    rowPreview: RowPreview | null;
    rowPreviewLoading: boolean;
    saving: boolean;
    mutationsDisabled: boolean;
    onFilterChange: (filter: RowFilter) => void;
    onSelectRow: (rowId: string) => void;
    onLoadMore: () => void;
    onDraftChange: (rowId: string, field: keyof RowDraft, value: string) => void;
    onFeeLinkChange: (rowId: string, linked: boolean) => void;
    feeLinked: boolean;
    onSaveRow: () => void;
    onResetRow: () => void;
    onSkipRow: () => void;
    onImportStudentOnly: () => void;
};

const paymentStatusOptions = ["", "DUE", "PAID", "WAIVED", "UNCLEAR"];

function rowTitle(row: ImportRow) {
    return importRowFieldValue(row, "studentName") || "No student name";
}

function rowSubtitle(row: ImportRow) {
    return [
        importRowFieldValue(row, "seat"),
        importRowFieldValue(row, "multiShift") || importRowFieldValue(row, "shift"),
    ].filter(Boolean).join(" / ") || "No seat or shift";
}

export function RowsStep({
    branchId,
    sessionId,
    detail,
    rows,
    rowFilter,
    selectedRow,
    selectedDraft,
    rowPreview,
    rowPreviewLoading,
    saving,
    mutationsDisabled,
    onFilterChange,
    onSelectRow,
    onLoadMore,
    onDraftChange,
    onFeeLinkChange,
    feeLinked,
    onSaveRow,
    onResetRow,
    onSkipRow,
    onImportStudentOnly,
}: RowsStepProps) {
    const branchContext = detail.branchContext;
    const liveIssues = rowPreview
        ? [...rowPreview.issues, ...rowPreview.warnings]
        : selectedRow
            ? [...selectedRow.issues, ...selectedRow.warnings]
            : [];
    const currentPaymentStatus = selectedDraft?.paymentStatus ?? "";
    const hasCustomPaymentStatus = currentPaymentStatus && !paymentStatusOptions.includes(currentPaymentStatus);

    return (
        <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
            <AppPanel
                title="Rows"
                description={detail.rowPage ? `${detail.rowPage.returnedRows} of ${detail.rowPage.filteredRows}` : "Paged staging rows"}
                action={
                    <select
                        aria-label="Filter import rows"
                        value={rowFilter}
                        onChange={event => onFilterChange(event.target.value as RowFilter)}
                        className={cn("h-8 px-2 py-0 text-xs", importSelectClass)}
                    >
                        {(["attention", "ready", "all", "skipped"] as RowFilter[]).map(filter => (
                            <option key={filter} value={filter} className={importOptionClass}>
                                {rowFilterLabels[filter]}
                            </option>
                        ))}
                    </select>
                }
                contentClassName="p-0"
            >
                <div className="max-h-[680px] overflow-y-auto p-2">
                    {rows.length === 0 && <p className={cn("p-3 text-sm", pageMutedTextClass)}>No rows in this filter.</p>}
                    {rows.map(row => {
                        const issues = [...row.issues, ...row.warnings];
                        const selected = selectedRow?.id === row.id;
                        return (
                            <button
                                key={row.id}
                                type="button"
                                onClick={() => onSelectRow(row.id)}
                                className={cn(
                                    "mb-2 w-full rounded-[8px] border p-3 text-left transition-colors hover:bg-white/[0.04]",
                                    selected
                                        ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)]"
                                        : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)]"
                                )}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
                                            Row {row.rowNumber}: {rowTitle(row)}
                                        </p>
                                        <p className={cn("mt-1 truncate text-xs", pageMutedTextClass)}>{rowSubtitle(row)}</p>
                                    </div>
                                    <StatusBadge status={row.status} />
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {row.skipped && <Badge variant="default">skipped</Badge>}
                                    {issues[0] && (
                                        <Badge variant={issues[0].severity === "error" ? "danger" : issues[0].severity === "warning" ? "warning" : "cyan"}>
                                            {issues[0].code.replace(/_/g, " ")}
                                        </Badge>
                                    )}
                                </div>
                            </button>
                        );
                    })}
                    {detail.rowPage?.hasMore && (
                        <AppButton className="mt-2 w-full" size="sm" variant="secondary" onClick={onLoadMore} isLoading={saving}>
                            Load more rows
                        </AppButton>
                    )}
                </div>
            </AppPanel>

            <div className="space-y-5">
                <AppPanel
                    title={selectedRow ? `Row ${selectedRow.rowNumber}` : "Select a row"}
                    description={selectedRow ? rowTitle(selectedRow) : "Choose a row from the left list."}
                    action={selectedRow && selectedDraft ? (
                        <div className="flex flex-wrap gap-2">
                            <AppButton
                                size="sm"
                                variant="primary"
                                icon={Save}
                                onClick={onSaveRow}
                                disabled={mutationsDisabled}
                                aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                isLoading={saving}
                            >
                                Save
                            </AppButton>
                            <AppButton size="sm" variant="quiet" icon={RotateCcw} onClick={onResetRow} disabled={saving}>
                                Reset
                            </AppButton>
                        </div>
                    ) : null}
                >
                    {!selectedRow || !selectedDraft ? (
                        <p className={pageMutedTextClass}>Select a row to review.</p>
                    ) : (
                        <div className="space-y-5">
                            <div className="grid gap-4 lg:grid-cols-2">
                                <label className="space-y-2">
                                    <span className={pickerSectionLabelClass}>Student name</span>
                                    <input value={selectedDraft.studentName} onChange={event => onDraftChange(selectedRow.id, "studentName", event.target.value)} className={cn("w-full", importFieldClass)} />
                                </label>
                                <label className="space-y-2">
                                    <span className={pickerSectionLabelClass}>Phone</span>
                                    <input value={selectedDraft.phone} onChange={event => onDraftChange(selectedRow.id, "phone", event.target.value)} className={cn("w-full", importFieldClass)} />
                                </label>
                                <label className="space-y-2">
                                    <span className={pickerSectionLabelClass}>Joined date</span>
                                    <input type="date" value={selectedDraft.joinedAt} onChange={event => onDraftChange(selectedRow.id, "joinedAt", event.target.value)} className={cn("w-full", importFieldClass)} />
                                </label>
                                <label className="space-y-2">
                                    <span className={pickerSectionLabelClass}>Monthly fee</span>
                                    <input value={selectedDraft.fee} onChange={event => onDraftChange(selectedRow.id, "fee", event.target.value)} className={cn("w-full", importFieldClass)} />
                                </label>
                            </div>

                            <CompactImportAllocationPicker
                                branchId={branchId}
                                sessionId={sessionId}
                                rowId={selectedRow.id}
                                draft={selectedDraft}
                                branchContext={branchContext}
                                feeLinked={feeLinked}
                                onDraftChange={(field, value) => onDraftChange(selectedRow.id, field, value)}
                                onFeeLinkChange={linked => onFeeLinkChange(selectedRow.id, linked)}
                            />

                            <div className={cn("p-4", pageInsetSurfaceClass)}>
                                <p className="text-sm font-semibold text-[color:var(--text-primary)]">Payment amount default</p>
                                <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>
                                    If this row has no payment override, payment generation uses the student monthly fee. Open the override only when this row has a different amount, paid status, method, or reference.
                                </p>
                            </div>

                            <details className={cn("group rounded-[8px] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)]")}>
                                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-[color:var(--text-primary)]">
                                    Row payment override
                                    <span className={cn("ml-2 text-xs font-normal", pageMutedTextClass)}>
                                        Optional row-level amount/status correction
                                    </span>
                                </summary>
                                <div className="grid gap-4 border-t border-[color:var(--ui-form-section-divider)] p-4 lg:grid-cols-4">
                                    <label className="space-y-2">
                                        <span className={pickerSectionLabelClass}>Payment amount</span>
                                        <input value={selectedDraft.paymentAmount} onChange={event => onDraftChange(selectedRow.id, "paymentAmount", event.target.value)} className={cn("w-full", importFieldClass)} />
                                    </label>
                                    <label className="space-y-2">
                                        <span className={pickerSectionLabelClass}>Payment status</span>
                                        <select value={selectedDraft.paymentStatus} onChange={event => onDraftChange(selectedRow.id, "paymentStatus", event.target.value)} className={cn("w-full", importSelectClass)}>
                                            {hasCustomPaymentStatus && <option value={currentPaymentStatus} className={importOptionClass}>Raw: {currentPaymentStatus}</option>}
                                            <option value="" className={importOptionClass}>No row status</option>
                                            <option value="DUE" className={importOptionClass}>Due</option>
                                            <option value="PAID" className={importOptionClass}>Paid</option>
                                            <option value="WAIVED" className={importOptionClass}>Waived</option>
                                            <option value="UNCLEAR" className={importOptionClass}>Unclear</option>
                                        </select>
                                    </label>
                                    <label className="space-y-2">
                                        <span className={pickerSectionLabelClass}>Method</span>
                                        <select value={selectedDraft.paymentMethod} onChange={event => onDraftChange(selectedRow.id, "paymentMethod", event.target.value)} className={cn("w-full", importSelectClass)}>
                                            <option value="" className={importOptionClass}>No method</option>
                                            <option value="CASH" className={importOptionClass}>Cash</option>
                                            <option value="UPI" className={importOptionClass}>UPI</option>
                                            <option value="BANK_TRANSFER" className={importOptionClass}>Bank transfer</option>
                                        </select>
                                    </label>
                                    <label className="space-y-2">
                                        <span className={pickerSectionLabelClass}>Reference</span>
                                        <input value={selectedDraft.referenceId} onChange={event => onDraftChange(selectedRow.id, "referenceId", event.target.value)} className={cn("w-full", importFieldClass)} />
                                    </label>
                                </div>
                            </details>

                            <div className="flex flex-wrap items-center gap-3 border-t border-[color:var(--ui-form-section-divider)] pt-4">
                                <AppButton
                                    variant="primary"
                                    icon={Save}
                                    onClick={onSaveRow}
                                    disabled={mutationsDisabled}
                                    aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                    isLoading={saving}
                                >
                                    Save row
                                </AppButton>
                                <AppButton
                                    variant="secondary"
                                    icon={UserRoundCheck}
                                    onClick={onImportStudentOnly}
                                    disabled={mutationsDisabled}
                                    aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                    isLoading={saving}
                                >
                                    Import student only
                                </AppButton>
                                <AppButton
                                    variant="quiet"
                                    icon={Pencil}
                                    onClick={onSkipRow}
                                    disabled={mutationsDisabled}
                                    aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                    isLoading={saving}
                                >
                                    {selectedRow.skipped ? "Unskip row" : "Skip row"}
                                </AppButton>
                                {rowPreviewLoading && (
                                    <span className="inline-flex items-center gap-2 text-xs text-[color:var(--text-muted)]">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Checking row
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                </AppPanel>

                <AppPanel title="Row checks" description="Validation checks for the selected row.">
                    <IssueList issues={liveIssues} />
                </AppPanel>

                {rowPreview?.paymentPreview && (
                    <AppPanel title="Payment preview" description={rowPreview.paymentPreview.enabled ? "Payment impact for this row." : "Payments are currently skipped or incomplete."}>
                        <div className="grid gap-3 sm:grid-cols-4">
                            <div className={cn("p-3", pageInsetSurfaceClass)}>
                                <p className={cn("text-xs", pageMutedTextClass)}>Amount</p>
                                <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">{formatAmount(rowPreview.paymentPreview.amount)}</p>
                            </div>
                            <div className={cn("p-3", pageInsetSurfaceClass)}>
                                <p className={cn("text-xs", pageMutedTextClass)}>Source</p>
                                <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">{rowPreview.paymentPreview.amountSource}</p>
                            </div>
                            <div className={cn("p-3", pageInsetSurfaceClass)}>
                                <p className={cn("text-xs", pageMutedTextClass)}>Status</p>
                                <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">{rowPreview.paymentPreview.status ?? "-"}</p>
                            </div>
                            <div className={cn("p-3", pageInsetSurfaceClass)}>
                                <p className={cn("text-xs", pageMutedTextClass)}>Method</p>
                                <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">{rowPreview.paymentPreview.method ?? "-"}</p>
                            </div>
                        </div>
                        <p className={cn("mt-3 text-xs leading-5", pageMutedTextClass)}>{rowPreview.paymentPreview.message}</p>
                    </AppPanel>
                )}

                <AppPanel title="Raw source" description="Original values from the uploaded file.">
                    {!selectedRow ? (
                        <p className={pageMutedTextClass}>Select a row.</p>
                    ) : (
                        <AccessibleTableScroll
                            label={`Raw source values for row ${selectedRow.rowNumber}`}
                            className="rounded-[8px] border border-[color:var(--ui-table-border)]"
                        >
                            <table className="w-full min-w-[540px] text-left text-xs">
                                <caption className="sr-only">Raw source values for row {selectedRow.rowNumber}</caption>
                                <thead className={pageTableHeadClass}>
                                    <tr>
                                        <th scope="col" className="p-2">Column</th>
                                        <th scope="col" className="p-2">Value</th>
                                    </tr>
                                </thead>
                                <tbody className={pageTableBodyDividerClass}>
                                    {Object.entries(selectedRow.rawData).map(([key, value]) => (
                                        <tr key={key} className={pageTableRowClass}>
                                            <th scope="row" className="p-2 text-left font-semibold text-[color:var(--text-primary)]">{key}</th>
                                            <td className={cn("p-2", pageMutedTextClass)}>{value || "-"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </AccessibleTableScroll>
                    )}
                </AppPanel>
            </div>
        </div>
    );
}
