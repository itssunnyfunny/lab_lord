import { ArrowRight, LayoutDashboard, ReceiptText, Sofa, UsersRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { cn } from "@/lib/utils";
import { pageInsetSurfaceClass, pageMutedTextClass } from "@/components/ui/pageSurface";
import { StatusBadge, StepNotice } from "./shared";
import type { ImportDetail } from "./types";

type ResultStepProps = {
    branchId: string;
    detail: ImportDetail;
    onGoPreview: () => void;
};

function formatSummaryLabel(label: string) {
    return label.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

function summaryNumber(summary: Record<string, number> | undefined, key: string) {
    const value = summary?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const knownCommitSummaryKeys = new Set([
    "createdStudents",
    "createdSeats",
    "createdShifts",
    "createdMultiShifts",
    "createdAllocations",
    "generatedPayments",
    "markedPaid",
    "markedWaived",
    "skippedRows",
    "failedRows",
]);

export function ResultStep({ branchId, detail, onGoPreview }: ResultStepProps) {
    const router = useRouter();
    const { formatDateTime, formatNumber } = useUserPreferences();
    const latestCommit = detail.commits?.[0];
    const summary = latestCommit?.summary;
    const createdStudents = summaryNumber(summary, "createdStudents");
    const createdAllocations = summaryNumber(summary, "createdAllocations");
    const generatedPayments = summaryNumber(summary, "generatedPayments");
    const markedPaid = summaryNumber(summary, "markedPaid");
    const markedWaived = summaryNumber(summary, "markedWaived");
    const skippedRows = summaryNumber(summary, "skippedRows");
    const failedRows = summaryNumber(summary, "failedRows");
    const setupCreated = summaryNumber(summary, "createdSeats") +
        summaryNumber(summary, "createdShifts") +
        summaryNumber(summary, "createdMultiShifts");
    const canContinueToBranch = Boolean(latestCommit && latestCommit.status !== "FAILED" && createdStudents > 0);
    const resultNotice = !latestCommit
        ? {
            tone: "cyan" as const,
            title: "No records created yet",
            message: "Preview is only a dry run. Results appear here after the final import is confirmed.",
        }
        : latestCommit.status === "FAILED"
            ? {
                tone: "danger" as const,
                title: "Import failed",
                message: "No complete commit was made. Review the errors below before trying again.",
            }
            : latestCommit.status === "PARTIAL"
                ? {
                    tone: "warning" as const,
                    title: "Partial import committed",
                    message: `${formatNumber(createdStudents)} student${createdStudents === 1 ? "" : "s"} were created. Skipped or failed rows remain in this import session for follow-up.`,
                }
                : {
                    tone: "success" as const,
                    title: "Import committed",
                    message: `${formatNumber(createdStudents)} student${createdStudents === 1 ? "" : "s"} were created in the branch records.`,
                };
    const resultCards: Array<[string, number]> = [
        ["Students created", createdStudents],
        ["Seat links created", createdAllocations],
        ["Payments generated", generatedPayments],
        ["Marked paid", markedPaid],
        ["Marked waived", markedWaived],
        ["Setup records created", setupCreated],
        ["Rows skipped", skippedRows],
        ["Rows failed", failedRows],
    ];

    return (
        <div className="space-y-5">
            <AppPanel
                title="Import result"
                description={latestCommit ? "The latest commit report for this import session." : "No import has been committed yet."}
            >
                {!latestCommit ? (
                    <div className="space-y-4">
                        <StepNotice tone={resultNotice.tone} title={resultNotice.title} message={resultNotice.message} />
                        <div className="flex flex-wrap gap-2">
                            <AppButton variant="primary" icon={ArrowRight} onClick={onGoPreview}>
                                Go to final preview
                            </AppButton>
                            <AppButton variant="secondary" onClick={() => router.push(`/branch/${branchId}/onboarding/import`)}>
                                Back to imports
                            </AppButton>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-5">
                        <StepNotice tone={resultNotice.tone} title={resultNotice.title} message={resultNotice.message} />

                        <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge status={detail.status} />
                            <Badge variant={latestCommit.status === "SUCCESS" ? "success" : latestCommit.status === "FAILED" ? "danger" : "warning"}>
                                {latestCommit.status}
                            </Badge>
                            {latestCommit.createdAt && (
                                <span className={cn("text-xs", pageMutedTextClass)}>{formatDateTime(latestCommit.createdAt)}</span>
                            )}
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {resultCards.map(([label, value]) => (
                                <div key={label} className={cn("p-3", pageInsetSurfaceClass)}>
                                    <p className={cn("text-xs", pageMutedTextClass)}>{label}</p>
                                    <p className="mt-1 text-xl font-semibold text-[color:var(--text-primary)]">{formatNumber(value)}</p>
                                </div>
                            ))}
                        </div>

                        {Object.keys(latestCommit.summary ?? {}).some(key => !knownCommitSummaryKeys.has(key)) && (
                            <details className={cn("rounded-[8px] border border-[color:var(--ui-form-surface-border)] p-3", pageInsetSurfaceClass)}>
                                <summary className="cursor-pointer list-none text-sm font-semibold text-[color:var(--text-primary)]">
                                    Additional commit counters
                                </summary>
                                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                                    {Object.entries(latestCommit.summary ?? {})
                                        .filter(([label]) => !knownCommitSummaryKeys.has(label))
                                        .map(([label, value]) => (
                                            <div key={label}>
                                                <p className={cn("text-xs", pageMutedTextClass)}>{formatSummaryLabel(label)}</p>
                                                <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">{formatNumber(value)}</p>
                                            </div>
                                        ))}
                                </div>
                            </details>
                        )}

                        {Array.isArray(latestCommit.errors) && latestCommit.errors.length > 0 && (
                            <div className="space-y-2">
                                {latestCommit.errors.slice(0, 10).map((error, index) => (
                                    <div key={index} className={cn("p-3", pageInsetSurfaceClass)}>
                                        <p className="text-sm font-semibold text-red-200">
                                            {typeof error === "object" && error && "rowNumber" in error
                                                ? `Row ${typeof (error as { rowNumber?: number }).rowNumber === "number" ? formatNumber((error as { rowNumber: number }).rowNumber) : "-"}`
                                                : "Import error"}
                                        </p>
                                        <p className={cn("mt-1 text-xs", pageMutedTextClass)}>
                                            {typeof error === "object" && error && "message" in error ? String((error as { message?: unknown }).message) : JSON.stringify(error)}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </AppPanel>

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
                                <button
                                    key={label as string}
                                    type="button"
                                    onClick={() => router.push(href as string)}
                                    className={cn(
                                        "flex min-h-24 items-center justify-between gap-3 rounded-[8px] border p-4 text-left transition-colors hover:bg-white/[0.04]",
                                        "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)]"
                                    )}
                                >
                                    <div>
                                        <ActionIcon className="h-5 w-5 text-cyan-300" />
                                        <p className="mt-2 text-sm font-semibold text-[color:var(--text-primary)]">{label as string}</p>
                                    </div>
                                    <ArrowRight className="h-4 w-4 text-[color:var(--text-muted)]" />
                                </button>
                            );
                        })}
                    </div>
                </AppPanel>
            )}

            {latestCommit && !canContinueToBranch && (
                <div className="flex flex-wrap gap-2">
                    <AppButton variant="primary" icon={ArrowRight} onClick={onGoPreview}>
                        Back to final preview
                    </AppButton>
                    <AppButton variant="secondary" onClick={() => router.push(`/branch/${branchId}/onboarding/import`)}>
                        Back to imports
                    </AppButton>
                </div>
            )}
        </div>
    );
}
