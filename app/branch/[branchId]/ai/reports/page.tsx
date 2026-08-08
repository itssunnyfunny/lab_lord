"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
    AlertTriangle,
    CheckCircle2,
    Printer,
    RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AppButton, AppPanel, ErrorState, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { BranchHealthPanel } from "@/components/ai/BranchHealthPanel";
import type { AIBranchReportSnapshot, AIStructuredBranchReport } from "@/ai/contracts/structuredReport.contract";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { cn } from "@/lib/utils";
import {
    pageGridCardClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";

interface AIResponse {
    report?: AIStructuredBranchReport;
    snapshot?: AIBranchReportSnapshot;
    meta?: {
        branchId: string;
        branchName: string;
        generatedAt: string;
    };
    hasPendingChanges?: boolean;
    nextAllowedCallAt?: string;
    risks?: {
        total: number;
        items: RiskDriver[];
    };
}

interface RiskDriver {
    type: string;
    severity: "LOW" | "MEDIUM" | "HIGH";
    explanation: string;
}

interface ReportSignal {
    label: string;
    riskLevel: "LOW" | "MODERATE" | "CRITICAL";
    observation: string;
}

const EMPTY_RISK_DRIVERS: RiskDriver[] = [];

const riskBadgeVariant: Record<string, "danger" | "warning" | "success" | "default"> = {
    CRITICAL: "danger",
    HIGH: "danger",
    MODERATE: "warning",
    MEDIUM: "warning",
    LOW: "success",
};

const riskAccentClass: Record<string, string> = {
    CRITICAL: "border-l-[color:var(--ui-tone-danger-progress)]",
    HIGH: "border-l-[color:var(--ui-tone-danger-progress)]",
    MODERATE: "border-l-[color:var(--ui-tone-warning-progress)]",
    MEDIUM: "border-l-[color:var(--ui-tone-warning-progress)]",
    LOW: "border-l-[color:var(--ui-tone-success-progress)]",
};

const readableTextClass = "text-[color:var(--text-primary)]";

function formatLabel(value: string) {
    return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value: string | number | null | undefined) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function slugify(value: string) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "branch";
}

function buildDownloadReportHtml({
    branchName,
    report,
    snapshot,
    signals,
    riskDrivers,
    formatCurrency,
    formatDate,
}: {
    branchName: string;
    report: AIStructuredBranchReport;
    snapshot: AIBranchReportSnapshot | null;
    signals: ReportSignal[];
    riskDrivers: RiskDriver[];
    formatCurrency: (value: number) => string;
    formatDate: (value?: string) => string;
}) {
    const findings = report.keyFindings?.filter(Boolean).slice(0, 3) ?? [];
    const metricCards = snapshot
        ? `
            <section class="section">
                <h2>Operating Snapshot</h2>
                <div class="metrics">
                    <div class="metric"><span>Utilization</span><strong>${escapeHtml(snapshot.seats.utilizationPercent.toFixed(1))}%</strong>${escapeHtml(snapshot.seats.occupied)}/${escapeHtml(snapshot.seats.total)} shift slots</div>
                    <div class="metric"><span>Active students</span><strong>${escapeHtml(snapshot.students.active)}</strong>${escapeHtml(snapshot.students.total)} total students</div>
                    <div class="metric"><span>Overdue payments</span><strong>${escapeHtml(snapshot.payments.overdueCount)}</strong>${escapeHtml(formatCurrency(snapshot.payments.overdueAmount))}</div>
                    <div class="metric"><span>Available slots</span><strong>${escapeHtml(snapshot.seats.available)}</strong>shift slots open</div>
                </div>
            </section>
        `
        : "";

    const riskTable = riskDrivers.length > 0
        ? `
            <section class="section">
                <h2>Score Drivers</h2>
                <table>
                    <caption>Risk drivers used in this report</caption>
                    <thead><tr><th scope="col">Driver</th><th scope="col">Severity</th><th scope="col">Explanation</th></tr></thead>
                    <tbody>
                        ${riskDrivers.map((risk) => `
                            <tr>
                                <th scope="row">${escapeHtml(formatLabel(risk.type))}</th>
                                <td>${escapeHtml(risk.severity)}</td>
                                <td>${escapeHtml(risk.explanation)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </section>
        `
        : "";

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(branchName)} AI Report</title>
    <style>
        :root { color: #111827; background: #f8fafc; font-family: Arial, sans-serif; }
        body { margin: 0; padding: 32px; }
        main { max-width: 960px; margin: 0 auto; background: #ffffff; border: 1px solid #d1d5db; padding: 32px; }
        header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111827; padding-bottom: 16px; }
        .kicker, .metric span, th { color: #4b5563; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
        h1 { margin: 4px 0 0; font-size: 30px; line-height: 1.1; }
        h2 { border-bottom: 1px solid #d1d5db; font-size: 16px; margin: 0 0 10px; padding-bottom: 5px; }
        p, li, td { color: #1f2937; }
        .score { border: 1px solid #111827; min-width: 170px; padding: 10px 12px; text-align: right; }
        .score strong { display: block; font-size: 18px; margin-top: 4px; }
        .section { break-inside: avoid; margin-top: 20px; }
        .summary { border: 1px solid #d1d5db; padding: 14px; }
        .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        .metric { border: 1px solid #d1d5db; padding: 10px; }
        .metric span, .metric strong { display: block; }
        .metric strong { color: #111827; font-size: 20px; margin: 4px 0; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #d1d5db; padding: 9px; text-align: left; vertical-align: top; }
        th { background: #f3f4f6; }
        footer { border-top: 1px solid #d1d5db; color: #6b7280; margin-top: 22px; padding-top: 10px; }
        @media print {
            body { background: #ffffff; padding: 0; }
            main { border: 0; padding: 0; }
        }
    </style>
</head>
<body>
    <main>
        <header>
            <div>
                <p class="kicker">AI Branch Report</p>
                <h1>${escapeHtml(branchName)}</h1>
                <p>Generated ${escapeHtml(formatDate(report.generatedAt))}</p>
            </div>
            <div class="score">
                Health score
                <strong>${escapeHtml(formatLabel(report.healthScore))}</strong>
            </div>
        </header>

        <section class="section summary">
            <p>${escapeHtml(report.executiveSummary ?? "This report summarizes the branch health signals and recommended actions.")}</p>
            <p><strong>Priority focus:</strong> ${escapeHtml(report.priorityFocus ?? "Review the highest-risk signal first.")}</p>
            ${findings.length > 0 ? `<ul>${findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul>` : ""}
        </section>

        ${metricCards}

        <section class="section">
            <h2>Signal Breakdown</h2>
            <table>
                <caption>Branch health signals and observations</caption>
                <thead><tr><th scope="col">Signal</th><th scope="col">Risk</th><th scope="col">Observation</th></tr></thead>
                <tbody>
                    ${signals.map((signal) => `
                        <tr>
                            <th scope="row">${escapeHtml(signal.label)}</th>
                            <td>${escapeHtml(signal.riskLevel)}</td>
                            <td>${escapeHtml(signal.observation)}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </section>

        <section class="section">
            <h2>Recommended Actions</h2>
            ${report.suggestedActions.length === 0
                ? "<p>No actions required at this time.</p>"
                : `<ol>${report.suggestedActions.map((actionItem) => `<li><strong>${escapeHtml(formatLabel(actionItem.action))}:</strong> ${escapeHtml(actionItem.reason)}</li>`).join("")}</ol>`
            }
        </section>

        ${riskTable}

        <footer>Report downloaded from Lab Lords AI reports. Data as of ${escapeHtml(formatDate(snapshot?.asOf ?? report.generatedAt))}.</footer>
    </main>
</body>
</html>`;
}

function downloadHtmlReport(filename: string, html: string) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function getReportSignals(report: AIStructuredBranchReport | null): ReportSignal[] {
    if (!report) return [];

    return [
        {
            label: "Financial",
            riskLevel: report.financialAnalysis.riskLevel,
            observation: report.financialAnalysis.observation,
        },
        {
            label: "Utilization",
            riskLevel: report.utilizationAnalysis.riskLevel,
            observation: report.utilizationAnalysis.observation,
        },
        {
            label: "Student Activity",
            riskLevel: report.studentActivityAnalysis.riskLevel,
            observation: report.studentActivityAnalysis.observation,
        },
    ];
}

export default function AIReportsPage() {
    const params = useParams();
    const branchId = params.branchId as string;

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.aiReports} feature="AI_REPORTS">
            {access => {
                const decision = getBranchCapabilityDecision(access, "aiGenerate");
                return decision.allowed ? (
                    <AIReportsContent branchId={branchId} />
                ) : (
                    <ErrorState
                        title="Report generation unavailable"
                        description={decision.reason}
                        restricted
                        action={decision.recoveryHref ? (
                            <a href={decision.recoveryHref} className="inline-flex min-h-11 items-center font-semibold text-cyan-200 underline underline-offset-4">
                                Review billing
                            </a>
                        ) : undefined}
                    />
                );
            }}
        </BranchAccessGuard>
    );
}

function AIReportsContent({ branchId }: { branchId: string }) {
    const { formatDateTime, formatNumber } = useUserPreferences();
    const formatCurrency = useCallback((value: number) => formatNumber(value, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }), [formatNumber]);
    const formatDate = useCallback((value?: string) => (
        value ? formatDateTime(value) : "Not available"
    ), [formatDateTime]);
    const [data, setData] = useState<AIResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/ai/branch/${branchId}`);
            if (!res.ok) {
                const details = await res.json().catch(() => null) as { error?: string; details?: string } | null;
                throw new Error(details?.details ?? details?.error ?? "Failed to fetch report");
            }

            const json = await res.json();
            setData(json);
        } catch (err) {
            console.error(err);
            setError(err instanceof Error ? err.message : "Failed to fetch report");
        } finally {
            setLoading(false);
        }
    }, [branchId]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const report = data?.report ?? null;
    const snapshot = data?.snapshot ?? null;
    const branchName = data?.meta?.branchName ?? snapshot?.branchName ?? "Branch";
    const riskDrivers = data?.risks?.items ?? EMPTY_RISK_DRIVERS;
    const reportSignals = useMemo(() => getReportSignals(report), [report]);

    const handlePrintReport = useCallback(() => {
        if (!report) return;

        const originalTitle = document.title;
        const restoreTitle = () => {
            document.title = originalTitle;
            window.removeEventListener("afterprint", restoreTitle);
        };

        document.title = `${branchName} AI report`;
        window.addEventListener("afterprint", restoreTitle);
        window.print();
    }, [branchName, report]);

    const handleDownloadReport = useCallback(() => {
        if (!report) return;

        downloadHtmlReport(
            `ai-report-${slugify(branchName)}-${new Date(report.generatedAt).toISOString().slice(0, 10)}.html`,
            buildDownloadReportHtml({
                branchName,
                report,
                snapshot,
                signals: reportSignals,
                riskDrivers,
                formatCurrency,
                formatDate,
            })
        );
    }, [branchName, formatCurrency, formatDate, report, reportSignals, riskDrivers, snapshot]);

    if (loading) {
        return <PageLoadingSkeleton label="Loading AI branch report" variant="ai" maxWidth="content" />;
    }

    return (
        <>
            <div className="ai-report-screen">
                <PageShell maxWidth="content">
                    <PageHeader
                        title="AI Branch Report"
                        subtitle="A clearer one-page read of health, risks, numbers, and next actions."
                        onExport={report ? handleDownloadReport : undefined}
                        exportLabel="Download report"
                        exportAriaLabel="Download AI report file"
                        extraActions={
                            report ? (
                                <AppButton variant="secondary" icon={Printer} onClick={handlePrintReport}>
                                    Print report
                                </AppButton>
                            ) : undefined
                        }
                    />

                    {error && (
                        <AppPanel title="Report unavailable" description="The AI report could not be loaded right now.">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <p className={cn("text-sm leading-6", pageMutedTextClass)}>{error}</p>
                                <AppButton variant="secondary" icon={RefreshCw} onClick={fetchData}>
                                    Try again
                                </AppButton>
                            </div>
                        </AppPanel>
                    )}

                    <BranchHealthPanel
                        report={report}
                        snapshot={snapshot}
                        branchName={branchName}
                        hasPendingChanges={data?.hasPendingChanges}
                        nextAllowedCallAt={data?.nextAllowedCallAt}
                        onRefresh={fetchData}
                    />

                    {report && (
                        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
                            <AppPanel
                                title="Action plan"
                                description="The next steps the owner can act on immediately."
                                contentClassName="space-y-3"
                            >
                                {report.suggestedActions.length === 0 ? (
                                    <div className={cn("p-4 text-sm", pageInsetSurfaceClass, pageSubtleTextClass)}>
                                        No actions required at this time.
                                    </div>
                                ) : (
                                    report.suggestedActions.map((actionItem, index) => (
                                        <article key={`${actionItem.action}-${index}`} className={cn(pageGridCardClass, "border-l-4 border-l-[color:var(--ui-tone-success-progress)]")}>
                                            <div className="flex items-start gap-3">
                                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[color:var(--ui-form-muted-surface-bg)] text-xs font-semibold text-[color:var(--text-primary)]">
                                                    {index + 1}
                                                </span>
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <CheckCircle2 size={15} className="shrink-0 text-[color:var(--ui-tone-success-text)]" />
                                                        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">
                                                            {formatLabel(actionItem.action)}
                                                        </h3>
                                                    </div>
                                                    <p className={cn("mt-2 text-sm leading-6", readableTextClass)}>{actionItem.reason}</p>
                                                </div>
                                            </div>
                                        </article>
                                    ))
                                )}
                            </AppPanel>

                            <AppPanel
                                title="Score drivers"
                                description="The deterministic signals behind the AI narrative."
                                contentClassName="space-y-3"
                            >
                                {riskDrivers.length === 0 ? (
                                    <div className={cn("flex items-start gap-3 p-4 text-sm", pageInsetSurfaceClass)}>
                                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ui-tone-success-text)]" />
                                        <p className={readableTextClass}>No major risk driver was detected in this run.</p>
                                    </div>
                                ) : (
                                    riskDrivers.map((risk, index) => (
                                        <article
                                            key={`${risk.type}-${index}`}
                                            className={cn(
                                                pageGridCardClass,
                                                "border-l-4",
                                                riskAccentClass[risk.severity] ?? "border-l-[color:var(--ui-card-border)]"
                                            )}
                                        >
                                            <div className="mb-2 flex items-start justify-between gap-3">
                                                <div className="flex min-w-0 items-center gap-2">
                                                    <AlertTriangle size={15} className="shrink-0 text-[color:var(--ui-tone-warning-text)]" />
                                                    <h3 className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
                                                        {formatLabel(risk.type)}
                                                    </h3>
                                                </div>
                                                <Badge variant={riskBadgeVariant[risk.severity] ?? "default"}>
                                                    {risk.severity}
                                                </Badge>
                                            </div>
                                            <p className={cn("text-sm leading-6", readableTextClass)}>{risk.explanation}</p>
                                        </article>
                                    ))
                                )}
                            </AppPanel>
                        </div>
                    )}
                </PageShell>
            </div>

            <PrintableAIReport
                branchName={branchName}
                report={report}
                snapshot={snapshot}
                signals={reportSignals}
                riskDrivers={riskDrivers}
                formatCurrency={formatCurrency}
                formatDate={formatDate}
            />
        </>
    );
}

function PrintableAIReport({
    branchName,
    report,
    snapshot,
    signals,
    riskDrivers,
    formatCurrency,
    formatDate,
}: {
    branchName: string;
    report: AIStructuredBranchReport | null;
    snapshot: AIBranchReportSnapshot | null;
    signals: ReportSignal[];
    riskDrivers: RiskDriver[];
    formatCurrency: (value: number) => string;
    formatDate: (value?: string) => string;
}) {
    if (!report) return null;

    const findings = report.keyFindings?.filter(Boolean).slice(0, 3) ?? [];

    return (
        <>
            <style>{`
                .ai-report-print-root { display: none; }

                @media print {
                    @page { size: A4; margin: 16mm; }
                    html, body { background: #ffffff !important; }
                    body * { visibility: hidden !important; }
                    .ai-report-screen { display: none !important; }
                    .ai-report-print-root,
                    .ai-report-print-root * {
                        visibility: visible !important;
                        box-shadow: none !important;
                    }
                    .ai-report-print-root {
                        display: block !important;
                        position: absolute;
                        inset: 0 auto auto 0;
                        width: 100%;
                        color: #111827;
                        font-family: Arial, sans-serif;
                        font-size: 11px;
                        line-height: 1.45;
                    }
                    .ai-report-print-page { width: 100%; }
                    .ai-report-print-header {
                        display: flex;
                        justify-content: space-between;
                        gap: 18px;
                        border-bottom: 2px solid #111827;
                        padding-bottom: 12px;
                        margin-bottom: 16px;
                    }
                    .ai-report-print-kicker {
                        color: #4b5563;
                        font-size: 10px;
                        font-weight: 700;
                        letter-spacing: 0.08em;
                        text-transform: uppercase;
                    }
                    .ai-report-print-title {
                        margin: 4px 0 0;
                        font-size: 24px;
                        line-height: 1.1;
                    }
                    .ai-report-print-score {
                        border: 1px solid #111827;
                        padding: 8px 10px;
                        min-width: 150px;
                        text-align: right;
                    }
                    .ai-report-print-score strong {
                        display: block;
                        font-size: 15px;
                        margin-top: 3px;
                    }
                    .ai-report-print-section {
                        break-inside: avoid;
                        margin-top: 14px;
                    }
                    .ai-report-print-section h2 {
                        border-bottom: 1px solid #d1d5db;
                        font-size: 13px;
                        margin: 0 0 8px;
                        padding-bottom: 4px;
                    }
                    .ai-report-print-summary {
                        border: 1px solid #d1d5db;
                        padding: 10px;
                    }
                    .ai-report-print-metrics {
                        display: grid;
                        grid-template-columns: repeat(4, 1fr);
                        gap: 8px;
                    }
                    .ai-report-print-metric {
                        border: 1px solid #d1d5db;
                        padding: 8px;
                    }
                    .ai-report-print-metric span {
                        color: #6b7280;
                        display: block;
                        font-size: 9px;
                        font-weight: 700;
                        letter-spacing: 0.05em;
                        text-transform: uppercase;
                    }
                    .ai-report-print-metric strong {
                        display: block;
                        font-size: 16px;
                        margin-top: 3px;
                    }
                    .ai-report-print-table {
                        border-collapse: collapse;
                        width: 100%;
                    }
                    .ai-report-print-table th,
                    .ai-report-print-table td {
                        border: 1px solid #d1d5db;
                        padding: 7px;
                        text-align: left;
                        vertical-align: top;
                    }
                    .ai-report-print-table th {
                        background: #f3f4f6;
                        font-size: 9px;
                        letter-spacing: 0.05em;
                        text-transform: uppercase;
                    }
                    .ai-report-print-actions {
                        margin: 0;
                        padding-left: 18px;
                    }
                    .ai-report-print-actions li {
                        margin-bottom: 6px;
                    }
                    .ai-report-print-footer {
                        border-top: 1px solid #d1d5db;
                        color: #6b7280;
                        margin-top: 18px;
                        padding-top: 8px;
                    }
                }
            `}</style>

            <section className="ai-report-print-root" aria-hidden="true">
                <div className="ai-report-print-page">
                    <header className="ai-report-print-header">
                        <div>
                            <p className="ai-report-print-kicker">AI Branch Report</p>
                            <h1 className="ai-report-print-title">{branchName}</h1>
                            <p>Generated {formatDate(report.generatedAt)}</p>
                        </div>
                        <div className="ai-report-print-score">
                            Health score
                            <strong>{formatLabel(report.healthScore)}</strong>
                        </div>
                    </header>

                    <section className="ai-report-print-section ai-report-print-summary">
                        <p>{report.executiveSummary ?? "This report summarizes the branch health signals and recommended actions."}</p>
                        <p><strong>Priority focus:</strong> {report.priorityFocus ?? "Review the highest-risk signal first."}</p>
                        {findings.length > 0 && (
                            <ul>
                                {findings.map((finding, index) => (
                                    <li key={`${finding}-${index}`}>{finding}</li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {snapshot && (
                        <section className="ai-report-print-section">
                            <h2>Operating Snapshot</h2>
                            <div className="ai-report-print-metrics">
                                <div className="ai-report-print-metric">
                                    <span>Utilization</span>
                                    <strong>{snapshot.seats.utilizationPercent.toFixed(1)}%</strong>
                                    {snapshot.seats.occupied}/{snapshot.seats.total} shift slots
                                </div>
                                <div className="ai-report-print-metric">
                                    <span>Active students</span>
                                    <strong>{snapshot.students.active}</strong>
                                    {snapshot.students.total} total students
                                </div>
                                <div className="ai-report-print-metric">
                                    <span>Overdue payments</span>
                                    <strong>{snapshot.payments.overdueCount}</strong>
                                    {formatCurrency(snapshot.payments.overdueAmount)}
                                </div>
                                <div className="ai-report-print-metric">
                                    <span>Available slots</span>
                                    <strong>{snapshot.seats.available}</strong>
                                    shift slots open
                                </div>
                            </div>
                        </section>
                    )}

                    <section className="ai-report-print-section">
                        <h2>Signal Breakdown</h2>
                        <table className="ai-report-print-table">
                            <caption className="sr-only">Branch health signals and observations</caption>
                            <thead>
                                <tr>
                                    <th scope="col">Signal</th>
                                    <th scope="col">Risk</th>
                                    <th scope="col">Observation</th>
                                </tr>
                            </thead>
                            <tbody>
                                {signals.map((signal) => (
                                    <tr key={signal.label}>
                                        <th scope="row">{signal.label}</th>
                                        <td>{signal.riskLevel}</td>
                                        <td>{signal.observation}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>

                    <section className="ai-report-print-section">
                        <h2>Recommended Actions</h2>
                        {report.suggestedActions.length === 0 ? (
                            <p>No actions required at this time.</p>
                        ) : (
                            <ol className="ai-report-print-actions">
                                {report.suggestedActions.map((actionItem, index) => (
                                    <li key={`${actionItem.action}-${index}`}>
                                        <strong>{formatLabel(actionItem.action)}:</strong> {actionItem.reason}
                                    </li>
                                ))}
                            </ol>
                        )}
                    </section>

                    {riskDrivers.length > 0 && (
                        <section className="ai-report-print-section">
                            <h2>Score Drivers</h2>
                            <table className="ai-report-print-table">
                                <caption className="sr-only">Risk drivers used in this report</caption>
                                <thead>
                                    <tr>
                                        <th scope="col">Driver</th>
                                        <th scope="col">Severity</th>
                                        <th scope="col">Explanation</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {riskDrivers.map((risk, index) => (
                                        <tr key={`${risk.type}-${index}`}>
                                            <th scope="row">{formatLabel(risk.type)}</th>
                                            <td>{risk.severity}</td>
                                            <td>{risk.explanation}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}

                    <footer className="ai-report-print-footer">
                        Paper view generated from Lab Lords AI reports. Data as of {formatDate(snapshot?.asOf ?? report.generatedAt)}.
                    </footer>
                </div>
            </section>
        </>
    );
}
