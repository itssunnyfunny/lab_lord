"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { AppPanel, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { AlertTriangle, CheckCircle, Info } from "lucide-react";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { cn } from "@/lib/utils";
import { formErrorBannerClass } from "@/components/ui/formSurface";
import {
    pageEmptyStateClass,
    pageGridCardClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";

interface AIResponse {
    health: { summary: string };
    risks: { items: Array<{ type: string; severity: string; explanation: string }> };
    actions: { items: Array<{ action: string; reason: string }> };
}

function getRiskVariant(severity: string): "danger" | "warning" {
    return severity === "HIGH" ? "danger" : "warning";
}

export default function AIInsightsPage() {
    const params = useParams();
    const branchId = params.branchId as string;

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.aiInsights} feature="AI_INSIGHTS">
            <AIInsightsContent branchId={branchId} />
        </BranchAccessGuard>
    );
}

function AIInsightsContent({ branchId }: { branchId: string }) {
    const [data, setData] = useState<AIResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        async function fetchData() {
            try {
                const res = await fetch(`/api/ai/branch/${branchId}`);

                if (!res.ok) {
                    throw new Error("Failed to fetch insights");
                }

                const json = await res.json();
                setData(json);
            } catch {
                setError("Could not load insights. Please try again.");
            } finally {
                setLoading(false);
            }
        }
        if (branchId) {
            fetchData();
        }
    }, [branchId]);

    if (loading) {
        return <PageLoadingSkeleton label="Loading smart insights" variant="ai" maxWidth="content" />;
    }

    if (error) {
        return (
            <div className="p-4 md:p-8">
                <PageShell maxWidth="content">
                    <div className={cn("px-4 py-3 text-sm", formErrorBannerClass)}>
                        <AlertTriangle className="mr-2 inline h-4 w-4" />
                        {error}
                    </div>
                </PageShell>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="p-4 md:p-8">
                <PageShell maxWidth="content">
                    <div className={pageEmptyStateClass}>No data received from API.</div>
                </PageShell>
            </div>
        );
    }

    const risks = data.risks?.items ?? [];
    const actions = data.actions?.items ?? [];

    return (
        <div className="p-4 md:p-8">
            <PageShell maxWidth="content">
                <PageHeader
                    title="Smart Insights"
                    subtitle="AI-driven analysis of your branch health."
                />

                <AppPanel title="Branch health summary" contentClassName="space-y-3">
                    <div className={cn("flex items-start gap-3 p-4", pageInsetSurfaceClass)}>
                        <Info size={18} className="mt-0.5 shrink-0 text-[color:var(--ui-tone-info-text)]" />
                        <p className={cn("text-sm leading-6", pageMutedTextClass)}>
                            {data.health?.summary || "No summary available."}
                        </p>
                    </div>
                </AppPanel>

                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                    <AppPanel
                        title="Detected risks"
                        description="Only the items that need attention."
                        contentClassName="space-y-3"
                    >
                        {risks.length === 0 ? (
                            <div className={cn("p-4 text-sm", pageInsetSurfaceClass, pageSubtleTextClass)}>
                                No major risks detected.
                            </div>
                        ) : (
                            risks.map((risk) => (
                                <article
                                    key={`${risk.type}-${risk.severity}`}
                                    className={cn(pageGridCardClass, "border-l-4 border-l-[color:var(--ui-tone-danger-progress)]")}
                                >
                                    <div className="mb-3 flex items-start justify-between gap-3">
                                        <span className="text-sm font-semibold text-[color:var(--text-primary)]">
                                            {risk.type}
                                        </span>
                                        <Badge variant={getRiskVariant(risk.severity)}>
                                            {risk.severity}
                                        </Badge>
                                    </div>
                                    <p className={cn("text-sm leading-6", pageMutedTextClass)}>{risk.explanation}</p>
                                </article>
                            ))
                        )}
                    </AppPanel>

                    <AppPanel
                        title="Suggested actions"
                        description="The clearest next steps."
                        contentClassName="space-y-3"
                    >
                        {actions.length === 0 ? (
                            <div className={cn("p-4 text-sm", pageInsetSurfaceClass, pageSubtleTextClass)}>
                                No actions required at this time.
                            </div>
                        ) : (
                            actions.map((action) => (
                                <article
                                    key={action.action}
                                    className={cn(pageGridCardClass, "border-l-4 border-l-[color:var(--ui-tone-success-progress)]")}
                                >
                                    <div className="mb-2 flex items-center gap-2">
                                        <CheckCircle size={15} className="shrink-0 text-[color:var(--ui-tone-success-text)]" />
                                        <span className="text-sm font-semibold text-[color:var(--text-primary)]">
                                            {action.action.replace(/_/g, " ")}
                                        </span>
                                    </div>
                                    <p className={cn("text-xs leading-5", pageMutedTextClass)}>{action.reason}</p>
                                </article>
                            ))
                        )}
                    </AppPanel>
                </div>
            </PageShell>
        </div>
    );
}
