import { CheckCircle2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { cn } from "@/lib/utils";
import {
    pageInsetMetricClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";
import {
    labelImportStatus,
    planCheckTone,
    statusTone,
    type ImportWizardTone,
} from "@/importing/utils/import-wizard-view-model";
import type { ImportIssue } from "@/importing/contracts/import-session.contract";

export const importFieldClass =
    "rounded-[8px] border border-[color:var(--ui-form-field-border)] bg-[color:var(--ui-form-field-bg)] p-2 text-sm text-[color:var(--text-primary)] outline-none transition-colors placeholder:text-[color:var(--text-muted)] focus:border-[color:var(--ui-form-input-focus-border)] focus:ring-2 focus:ring-[color:var(--ui-form-input-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60";

export const importSelectClass = `${importFieldClass} [color-scheme:dark]`;

export const importOptionClass =
    "bg-[color:var(--ui-form-input-select-bg)] text-[color:var(--ui-form-input-text)]";

export const rowFilterLabels = {
    attention: "Needs attention",
    ready: "Ready",
    all: "All rows",
    skipped: "Skipped",
} as const;

export const previewSummaryLabels: Record<string, string> = {
    createStudents: "Students",
    createSeats: "Create seats",
    createShifts: "Create shifts",
    createMultiShifts: "Create bundles",
    createAllocations: "Seat links",
    generatePayments: "Payments",
    markPaid: "Mark paid",
    markWaived: "Mark waived",
    historicalPaid: "Historical paid",
    historicalDue: "Historical due",
    currentCyclePayments: "Current cycle",
    skippedHistoricalPayments: "Old cycles skipped",
    skippedRows: "Skipped",
    blockedRows: "Blocked",
    warningRows: "Warnings",
};

export function AccessibleTableScroll({
    label,
    children,
    className,
}: {
    label: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            role="region"
            aria-label={label}
            tabIndex={0}
            className={cn(
                "overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]",
                className
            )}
        >
            {children}
        </div>
    );
}

function FormattedImportAmount({ value }: { value: number }) {
    const { formatNumber } = useUserPreferences();
    return <>Rs {formatNumber(value)}</>;
}

export function formatAmount(value: number | null | undefined): ReactNode {
    if (value === null || value === undefined) return "-";
    return <FormattedImportAmount value={value} />;
}

export function Metric({
    label,
    value,
    tone = "default",
}: {
    label: string;
    value: string | number;
    tone?: ImportWizardTone;
}) {
    const { formatNumber } = useUserPreferences();
    const displayValue = typeof value === "number" ? formatNumber(value) : value;

    return (
        <div className={pageInsetMetricClass}>
            <div className="flex items-center justify-between gap-2">
                <p className={cn("text-xs", pageMutedTextClass)}>{label}</p>
                <Badge variant={tone}>{displayValue}</Badge>
            </div>
            <p className="mt-2 text-lg font-semibold text-[color:var(--text-primary)]">{displayValue}</p>
        </div>
    );
}

export function StatusBadge({ status }: { status: string | undefined | null }) {
    return <Badge variant={statusTone(status)}>{labelImportStatus(status)}</Badge>;
}

export function PlanCheckBadge({ status }: { status: string }) {
    return <Badge variant={planCheckTone(status)}>{status}</Badge>;
}

export function IssueList({ issues, emptyText = "Clean" }: { issues: ImportIssue[]; emptyText?: string }) {
    if (issues.length === 0) {
        return (
            <div className={cn("p-3", pageInsetSurfaceClass)}>
                <div className="flex items-center gap-2 text-sm text-emerald-200">
                    <CheckCircle2 className="h-4 w-4" />
                    {emptyText}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {issues.map((issue, index) => (
                <div key={`${issue.code}-${index}`} className={cn("p-3", pageInsetSurfaceClass)}>
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={issue.severity === "error" ? "danger" : issue.severity === "warning" ? "warning" : "cyan"}>
                            {issue.severity}
                        </Badge>
                        <p className="text-sm font-semibold text-[color:var(--text-primary)]">{issue.code.replace(/_/g, " ")}</p>
                    </div>
                    <p className={cn("mt-2 text-xs", pageMutedTextClass)}>{issue.message}</p>
                </div>
            ))}
        </div>
    );
}

export function StepNotice({
    tone,
    title,
    message,
}: {
    tone: ImportWizardTone;
    title: string;
    message: string;
}) {
    const Icon = tone === "danger" ? XCircle : CheckCircle2;

    return (
        <div className={cn("flex items-start gap-3 p-3", pageInsetSurfaceClass)}>
            <Icon className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                tone === "danger" && "text-red-300",
                tone === "warning" && "text-amber-300",
                tone === "success" && "text-emerald-300",
                tone === "cyan" && "text-cyan-300",
                tone === "default" && pageSubtleTextClass
            )} />
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</p>
                    <Badge variant={tone}>{tone}</Badge>
                </div>
                <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>{message}</p>
            </div>
        </div>
    );
}
