import { useState } from "react";
import { ArrowRight, Download, LayoutDashboard, Loader2, ReceiptText, RotateCcw, Save, Sofa, UsersRound, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { cn } from "@/lib/utils";
import { pageInsetSurfaceClass, pageMutedTextClass, pageProgressTrackClass } from "@/components/ui/pageSurface";
import { importFieldClass, StatusBadge, StepNotice } from "./shared";
import type { ImportDetail, Run } from "./types";

type ResultStepProps = {
    branchId: string;
    detail: ImportDetail;
    run: Run | null;
    runLoading: boolean;
    actionLoading: boolean;
    onGoPreview: () => void;
    onCancelRun: () => void;
    onRetryRun: () => void;
    canRetryRun: boolean;
    onRepairRun: () => void;
    onExportErrors: (format: "csv" | "xlsx") => void;
    onSaveRecipe?: (name: string) => Promise<void>;
    recipeSaved?: string | null;
};

function summaryNumber(summary: Record<string, number> | undefined, key: string) {
    const value = summary?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const activeStatuses = new Set(["QUEUED", "RUNNING", "RETRYABLE_FAILURE", "CANCEL_REQUESTED"]);
const successfulStatuses = new Set(["COMPLETED", "COMPLETED_WITH_ISSUES"]);
const repairableStatuses = new Set(["COMPLETED_WITH_ISSUES", "PERMANENT_FAILURE"]);

export function ResultStep({
    branchId,
    detail,
    run,
    runLoading,
    actionLoading,
    onGoPreview,
    onCancelRun,
    onRetryRun,
    canRetryRun,
    onRepairRun,
    onExportErrors,
    onSaveRecipe,
    recipeSaved,
}: ResultStepProps) {
    const router = useRouter();
    const { formatDateTime, formatNumber } = useUserPreferences();
    const [recipeName, setRecipeName] = useState("");
    const latestCommit = detail.commits?.[0];
    const isCommitRun = run?.kind === "COMMIT";
    const active = Boolean(run && activeStatuses.has(run.status));
    const complete = Boolean(run && successfulStatuses.has(run.status));
    const repairable = Boolean(run && repairableStatuses.has(run.status));
    const progress = run?.totalItems ? Math.min(100, Math.round(run.completedItems / run.totalItems * 100)) : active ? 0 : complete ? 100 : 0;
    const legacySummary = latestCommit?.summary;
    const createdStudents = summaryNumber(legacySummary, "createdStudents");
    const canContinueToBranch = complete || Boolean(latestCommit && createdStudents > 0);
    const hasResult = isCommitRun || Boolean(latestCommit);
    const notice = active
        ? {
            tone: "cyan" as const,
            title: run?.status === "QUEUED"
                ? "Import is queued"
                : run?.status === "RETRYABLE_FAILURE"
                    ? "Import is retrying safely"
                    : run?.status === "CANCEL_REQUESTED"
                        ? "Cancellation requested"
                        : "Import is running in the background",
            message: run?.status === "RETRYABLE_FAILURE"
                ? "A temporary failure is being retried with bounded backoff. Completed work remains saved, and progress will keep refreshing."
                : "You can leave this page safely. Return to this import session to resume live progress and see the saved result.",
        }
        : complete
            ? {
                tone: run?.status === "COMPLETED_WITH_ISSUES" ? "warning" as const : "success" as const,
                title: run?.status === "COMPLETED_WITH_ISSUES" ? "Import finished with issues" : "Import completed",
                message: run?.status === "COMPLETED_WITH_ISSUES" ? "Successful items were saved. Download the error report to correct and retry unresolved data." : "The reviewed background run finished and its successful records are available in the branch.",
            }
            : run && ["PERMANENT_FAILURE", "CANCELLED", "SUPERSEDED"].includes(run.status)
                    ? {
                        tone: "danger" as const,
                        title: run.status === "CANCELLED" ? "Import cancelled" : run.status === "SUPERSEDED" ? "Run replaced by a newer run" : "Import could not finish",
                        message: run.error?.message ?? "Review the saved plan and error report before taking the next action.",
                    }
                    : latestCommit
                        ? {
                            tone: latestCommit.status === "SUCCESS" ? "success" as const : latestCommit.status === "FAILED" ? "danger" as const : "warning" as const,
                            title: latestCommit.status === "SUCCESS" ? "Import committed" : latestCommit.status === "FAILED" ? "Import failed" : "Partial import committed",
                            message: "This is a legacy import result. Its saved counters remain available below.",
                        }
                        : {
                            tone: "cyan" as const,
                            title: runLoading ? "Checking import progress" : "No import run yet",
                            message: "Build and confirm a reviewed plan to start a resumable background import.",
                        };

    const runCards: Array<[string, number]> = run ? [
        ["Total work items", run.totalItems],
        ["Completed", run.completedItems],
        ["Succeeded", run.succeededItems],
        ["Failed", run.failedItems],
        ["Skipped", run.skippedItems],
        ["Cancelled", run.cancelledItems],
    ] : [
        ["Students created", createdStudents],
        ["Seat links created", summaryNumber(legacySummary, "createdAllocations")],
        ["Payments generated", summaryNumber(legacySummary, "generatedPayments")],
        ["Rows failed", summaryNumber(legacySummary, "failedRows")],
    ];

    return (
        <div className="space-y-5">
            <AppPanel title="Import progress & result" description={hasResult ? "Saved progress for the latest import run." : "No branch records have been created from this session yet."}>
                <div className="space-y-5" aria-busy={runLoading}>
                    <div role="status" aria-live="polite" aria-atomic="true">
                        <StepNotice tone={notice.tone} title={notice.title} message={notice.message} />
                    </div>

                    {run && (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                <StatusBadge status={run.status} />
                                <Badge variant="cyan">{run.kind === "COMMIT" ? "Import run" : "Analysis run"}</Badge>
                                <span className={cn("text-xs", pageMutedTextClass)}>Updated {formatDateTime(run.updatedAt ?? run.createdAt)}</span>
                                {runLoading && <Loader2 className="h-4 w-4 animate-spin" aria-label="Refreshing progress" />}
                            </div>
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                                    <span className={pageMutedTextClass}>Background progress</span>
                                    <span className="font-semibold text-[color:var(--text-primary)]">{formatNumber(progress)}%</span>
                                </div>
                                <div className={pageProgressTrackClass} role="progressbar" aria-label="Background import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                                    <div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: `${progress}%` }} />
                                </div>
                            </div>
                        </>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {runCards.map(([label, value]) => (
                            <div key={label} className={cn("p-3", pageInsetSurfaceClass)}>
                                <p className={cn("text-xs", pageMutedTextClass)}>{label}</p>
                                <p className="mt-1 text-xl font-semibold text-[color:var(--text-primary)]">{formatNumber(value)}</p>
                            </div>
                        ))}
                    </div>

                    {run?.error?.message && (
                        <div className={cn("p-3", pageInsetSurfaceClass)} role="alert">
                            <div className="flex items-center gap-2 text-sm font-semibold text-red-200"><XCircle className="h-4 w-4" />Run error</div>
                            <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>{run.error.message}</p>
                        </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                        {run && ["QUEUED", "RUNNING", "RETRYABLE_FAILURE"].includes(run.status) && (
                            <AppButton variant="secondary" onClick={onCancelRun} isLoading={actionLoading}>Cancel import</AppButton>
                        )}
                        {repairable && canRetryRun && (
                            <AppButton variant="primary" icon={RotateCcw} onClick={onRetryRun} isLoading={actionLoading}>Retry remaining work</AppButton>
                        )}
                        {repairable && !canRetryRun && (
                            <AppButton variant="primary" icon={ArrowRight} onClick={onRepairRun}>Fix issues and review a new plan</AppButton>
                        )}
                        {run && run.failedItems > 0 && (
                            <>
                                <AppButton variant="secondary" icon={Download} onClick={() => onExportErrors("csv")} isLoading={actionLoading}>Download error CSV</AppButton>
                                <AppButton variant="secondary" icon={Download} onClick={() => onExportErrors("xlsx")} isLoading={actionLoading}>Download error XLSX</AppButton>
                            </>
                        )}
                        {!hasResult && !runLoading && <AppButton variant="primary" icon={ArrowRight} onClick={onGoPreview}>Go to review & import</AppButton>}
                        <AppButton variant="quiet" onClick={() => router.push(`/branch/${branchId}/onboarding/import`)}>All imports</AppButton>
                    </div>
                </div>
            </AppPanel>

            {complete && onSaveRecipe && (
                <AppPanel title="Reuse these column meanings" description="Save a recipe after success. Future files with the same headers can start with these mappings, and you will still review them before import.">
                    {recipeSaved ? (
                        <StepNotice tone="success" title="Recipe saved" message={`${recipeSaved} is ready for matching future imports.`} />
                    ) : (
                        <form
                            className="flex flex-col gap-3 sm:flex-row"
                            onSubmit={event => {
                                event.preventDefault();
                                const name = recipeName.trim();
                                if (name) void onSaveRecipe(name);
                            }}
                        >
                            <div className="min-w-0 flex-1">
                                <label htmlFor="import-recipe-name" className="text-xs font-semibold text-[color:var(--text-secondary)]">Recipe name</label>
                                <input id="import-recipe-name" value={recipeName} onChange={event => setRecipeName(event.target.value)} className={cn("mt-2 w-full", importFieldClass)} placeholder="Example: August student register" />
                            </div>
                            <AppButton className="sm:self-end" type="submit" variant="secondary" icon={Save} disabled={!recipeName.trim()} isLoading={actionLoading}>Save recipe</AppButton>
                        </form>
                    )}
                </AppPanel>
            )}

            {canContinueToBranch && (
                <AppPanel title="Next" description="Open the records created or continue operating the branch.">
                    <div className="grid gap-3 md:grid-cols-4">
                        {[
                            ["View students", UsersRound, `/branch/${branchId}/students`],
                            ["Review payments", ReceiptText, `/branch/${branchId}/payments`],
                            ["Map allocations", Sofa, `/branch/${branchId}/allocations`],
                            ["Dashboard", LayoutDashboard, `/branch/${branchId}`],
                        ].map(([label, Icon, href]) => {
                            const ActionIcon = Icon as typeof UsersRound;
                            return (
                                <button key={label as string} type="button" onClick={() => router.push(href as string)} className={cn("flex min-h-24 items-center justify-between gap-3 rounded-[8px] border p-4 text-left transition-colors hover:bg-white/[0.04]", "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)]")}>
                                    <div><ActionIcon className="h-5 w-5 text-cyan-300" /><p className="mt-2 text-sm font-semibold text-[color:var(--text-primary)]">{label as string}</p></div>
                                    <ArrowRight className="h-4 w-4 text-[color:var(--text-muted)]" />
                                </button>
                            );
                        })}
                    </div>
                </AppPanel>
            )}
        </div>
    );
}
