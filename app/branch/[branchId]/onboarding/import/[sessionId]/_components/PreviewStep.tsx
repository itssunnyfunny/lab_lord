import { RotateCcw, UploadCloud } from "lucide-react";
import { AppButton, AppPanel, AppSelect } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { cn } from "@/lib/utils";
import type { CommitMode, ImportOptions } from "@/importing/contracts/import-session.contract";
import { isPaymentSkipped, isPreviewFresh } from "@/importing/utils/import-wizard-view-model";
import { pageInsetSurfaceClass, pageMutedTextClass, pageTableBodyDividerClass, pageTableHeadClass, pageTableRowClass } from "@/components/ui/pageSurface";
import { AccessibleTableScroll, PlanCheckBadge, StepNotice, previewSummaryLabels, StatusBadge } from "./shared";
import type { Preview } from "./types";

type PreviewStepProps = {
    preview: Preview | null;
    importOptions: ImportOptions;
    commitMode: CommitMode;
    saving: boolean;
    mutationsDisabled: boolean;
    onModeChange: (mode: CommitMode) => void;
    onRefreshPreview: () => void;
    onConfirmImport: () => void;
};

export function PreviewStep({
    preview,
    importOptions,
    commitMode,
    saving,
    mutationsDisabled,
    onModeChange,
    onRefreshPreview,
    onConfirmImport,
}: PreviewStepProps) {
    const { formatDateTime, formatNumber } = useUserPreferences();
    const previewFresh = isPreviewFresh(preview, commitMode);
    const rowsNotImported = (preview?.summary.blockedRows ?? 0) + (preview?.summary.skippedRows ?? 0);
    const commitLabel = !preview
        ? "Refresh final preview"
        : commitMode === "SAFE_PARTIAL"
            ? rowsNotImported > 0
                ? `Import ${formatNumber(preview.summary.createStudents)} ready, skip ${formatNumber(rowsNotImported)}`
                : `Import ${formatNumber(preview.summary.createStudents)} students`
            : "Import all rows";
    const modeLabel = commitMode === "SAFE_PARTIAL"
        ? "Ready rows only"
        : "All rows must pass";
    const allocationsDeferred = Boolean(
        importOptions.skipUnknownSeatAllocations &&
        importOptions.skipUnknownShiftAllocations &&
        importOptions.skipUnknownMultiShiftAllocations &&
        importOptions.skipMissingShiftAllocations &&
        importOptions.skipConflictingAllocations
    );
    const paymentsSkipped = isPaymentSkipped(importOptions);
    const previewNotice = !preview
        ? {
            tone: "cyan" as const,
            title: "Preview is a dry run",
            message: "Refresh builds a plan from saved decisions and row edits. It does not create students, seats, allocations, or payments.",
        }
        : !previewFresh
            ? {
                tone: "warning" as const,
                title: "Plan needs refresh",
                message: "The selected import mode changed after this plan was generated. Refresh before importing.",
            }
            : preview.canCommit
                ? {
                    tone: "success" as const,
                    title: "Dry-run plan is ready",
                    message: "Confirming this plan creates only the records shown as will import. Skipped and blocked rows stay in this import session.",
                }
                : {
                    tone: "danger" as const,
                    title: "Plan is blocked",
                    message: "Fix open blockers or use safe partial mode so ready rows can import while blocked rows remain staged.",
                };

    return (
        <div className="space-y-5">
            <AppPanel
                title="Final preview"
                description={preview?.planVersion ? `Plan ${preview.planVersion}` : "Refresh the plan before importing."}
                action={
                    <div className="flex flex-wrap gap-2">
                        <label htmlFor="import-commit-mode" className="sr-only">Import mode</label>
                        <AppSelect
                            id="import-commit-mode"
                            value={commitMode}
                            onValueChange={value => onModeChange(value as CommitMode)}
                            options={[
                                { value: "SAFE_PARTIAL", label: "Safe partial" },
                                { value: "STRICT_ALL_OR_NOTHING", label: "Strict all or nothing" },
                            ]}
                            className="h-11 min-h-11 px-3 py-0 lg:h-10 lg:min-h-10"
                        />
                        <AppButton
                            variant="secondary"
                            icon={RotateCcw}
                            onClick={onRefreshPreview}
                            isLoading={saving}
                        >
                            Refresh
                        </AppButton>
                    </div>
                }
            >
                <div className="space-y-5">
                    <StepNotice
                        tone={previewNotice.tone}
                        title={previewNotice.title}
                        message={previewNotice.message}
                    />

                    {!preview ? (
                        <div className={cn("p-4 text-sm", pageInsetSurfaceClass, pageMutedTextClass)}>
                            No dry-run plan has been generated yet.
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge variant={preview.canCommit ? "success" : "danger"}>{preview.canCommit ? "Ready" : "Blocked"}</Badge>
                                <Badge variant={previewFresh ? "success" : "warning"}>{previewFresh ? "Fresh plan" : "Refresh needed"}</Badge>
                                <Badge variant="cyan">{modeLabel}</Badge>
                                {preview.canCommit && previewFresh && (
                                    <Badge variant="purple">Database write ready</Badge>
                                )}
                                <span className={cn("text-xs", pageMutedTextClass)}>{formatDateTime(preview.generatedAt)}</span>
                            </div>

                            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                                {Object.entries(preview.summary).map(([label, value]) => (
                                    <div key={label} className={cn("p-3", pageInsetSurfaceClass)}>
                                        <p className={cn("text-xs", pageMutedTextClass)}>{previewSummaryLabels[label] ?? label}</p>
                                        <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">{formatNumber(value)}</p>
                                    </div>
                                ))}
                            </div>

                            <div className="grid gap-3 md:grid-cols-3">
                                <div className={cn("p-3", pageInsetSurfaceClass)}>
                                    <p className={cn("text-xs", pageMutedTextClass)}>Students after confirm</p>
                                    <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">
                                        {formatNumber(preview.summary.createStudents)} will be created
                                    </p>
                                    <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>
                                        From rows marked will import.
                                    </p>
                                </div>
                                <div className={cn("p-3", pageInsetSurfaceClass)}>
                                    <p className={cn("text-xs", pageMutedTextClass)}>Seat/shift after confirm</p>
                                    <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">
                                        {allocationsDeferred ? "Deferred when unclear" : `${formatNumber(preview.summary.createAllocations)} allocation links`}
                                    </p>
                                    <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>
                                        {allocationsDeferred ? "Unclear rows become students without allocation links." : "Links are created only where seat and shift are valid."}
                                    </p>
                                </div>
                                <div className={cn("p-3", pageInsetSurfaceClass)}>
                                    <p className={cn("text-xs", pageMutedTextClass)}>Payments after confirm</p>
                                    <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">
                                        {paymentsSkipped ? "Skipped for now" : `${formatNumber(preview.summary.generatePayments)} payments planned`}
                                    </p>
                                    <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>
                                        {paymentsSkipped ? "No due or paid records will be created." : "Payment records follow joined-date billing and stop at today."}
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-2">
                                {preview.checks.map(check => (
                                    <div key={check.code} className={cn("p-3", pageInsetSurfaceClass)}>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <PlanCheckBadge status={check.status} />
                                            <p className="text-sm font-semibold text-[color:var(--text-primary)]">{check.label}</p>
                                            {typeof check.count === "number" && <Badge variant="default">{formatNumber(check.count)}</Badge>}
                                        </div>
                                        <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>{check.message}</p>
                                        {check.action && <p className="mt-1 text-xs text-amber-200">{check.action}</p>}
                                    </div>
                                ))}
                            </div>
                        </>
                    )}

                    <AppButton
                        variant="primary"
                        icon={UploadCloud}
                        onClick={preview ? onConfirmImport : onRefreshPreview}
                        disabled={preview ? mutationsDisabled || !preview.canCommit || !previewFresh : false}
                        aria-describedby={preview && mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                        isLoading={saving}
                    >
                        {commitLabel}
                    </AppButton>
                </div>
            </AppPanel>

            {preview && (
                <AppPanel title="Rows in this plan" description="The commit service revalidates this plan before creating records." contentClassName="p-0">
                    <AccessibleTableScroll
                        label="Rows in the final import plan"
                        className="max-h-[460px]"
                    >
                        <table className="w-full min-w-[820px] text-left text-sm">
                            <caption className="sr-only">Rows included in the final import plan</caption>
                            <thead className={pageTableHeadClass}>
                                <tr className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">
                                    <th scope="col" className="p-3">Row</th>
                                    <th scope="col" className="p-3">Student</th>
                                    <th scope="col" className="p-3">Seat / shift</th>
                                    <th scope="col" className="p-3">Status</th>
                                    <th scope="col" className="p-3">Action</th>
                                </tr>
                            </thead>
                            <tbody className={pageTableBodyDividerClass}>
                                {preview.rows.slice(0, 80).map(row => (
                                    <tr key={row.rowId} className={pageTableRowClass}>
                                        <th scope="row" className="p-3 text-left font-normal">#{formatNumber(row.rowNumber)}</th>
                                        <td className="p-3 font-medium text-[color:var(--text-primary)]">{row.normalizedData?.student?.name ?? "-"}</td>
                                        <td className={cn("p-3", pageMutedTextClass)}>
                                            {[
                                                row.normalizedData?.allocation?.seatLabel,
                                                row.normalizedData?.allocation?.multiShiftName ?? row.normalizedData?.allocation?.shiftName,
                                            ].filter(Boolean).join(" / ") || "-"}
                                        </td>
                                        <td className="p-3"><StatusBadge status={row.status} /></td>
                                        <td className="p-3">
                                            <Badge variant={row.willImport ? "success" : "default"}>
                                                {row.willImport ? "Will import" : "Skipped"}
                                            </Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </AccessibleTableScroll>
                    {preview.rows.length > 80 && (
                        <p className={cn("border-t border-[color:var(--ui-table-border)] p-3 text-xs", pageMutedTextClass)}>
                            Showing first 80 rows from the final plan.
                        </p>
                    )}
                </AppPanel>
            )}
        </div>
    );
}
