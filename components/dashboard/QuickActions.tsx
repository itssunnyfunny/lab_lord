"use client";

import { AppPanel } from "@/components/ui";
import {
    pageInsetHoverClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";
import { useBranchAccess } from "@/hooks/useBranchAccess";
import type { BranchCapabilityKey } from "@/lib/branchCapabilities";
import { cn } from "@/lib/utils";
import { ArrowRight, CalendarCheck, CreditCard, Grid, LockKeyhole, LucideIcon, MessageSquareText, TriangleAlert, UploadCloud, UserPlus } from "lucide-react";
import Link from "next/link";

interface Action {
    label: string;
    description: string;
    icon: LucideIcon;
    route: string;
    tone: string;
    capability: BranchCapabilityKey;
}

const actions: Action[] = [
    {
        label: "Overdue queue",
        description: "Prioritize collection follow-ups",
        icon: TriangleAlert,
        route: "/overdue",
        tone: "text-rose-300 bg-rose-400/10",
        capability: "overdueView",
    },
    {
        label: "Draft follow-ups",
        description: "Review AI reminder drafts",
        icon: MessageSquareText,
        route: "/ai/messages",
        tone: "text-indigo-300 bg-indigo-400/10",
        capability: "aiUse",
    },
    {
        label: "Record payment",
        description: "Mark a due as paid",
        icon: CreditCard,
        route: "/payments",
        tone: "text-emerald-300 bg-emerald-400/10",
        capability: "paymentsRecord",
    },
    {
        label: "Add student",
        description: "Create a student profile",
        icon: UserPlus,
        route: "/students",
        tone: "text-cyan-300 bg-cyan-400/10",
        capability: "studentsManage",
    },
    {
        label: "Assign seat",
        description: "Allocate a student to a slot",
        icon: Grid,
        route: "/allocations",
        tone: "text-violet-300 bg-violet-400/10",
        capability: "allocationsManage",
    },
    {
        label: "Import records",
        description: "Onboard existing data",
        icon: UploadCloud,
        route: "/onboarding/import",
        tone: "text-sky-300 bg-sky-400/10",
        capability: "importStudents",
    },
    {
        label: "Review shifts",
        description: "Review capacity and schedules",
        icon: CalendarCheck,
        route: "/shifts",
        tone: "text-amber-300 bg-amber-400/10",
        capability: "shiftsView",
    },
];

export function QuickActions({ branchId }: { branchId: string }) {
    const { access, loading, decide } = useBranchAccess(branchId);
    const evaluatedActions = access
        ? actions.map(action => ({ action, decision: decide(action.capability) }))
        : [];
    const visibleActions = evaluatedActions.filter(item => item.decision.allowed);
    const unavailableActions = evaluatedActions.filter(
        item => !item.decision.allowed && item.decision.blocker !== "permission"
    );

    return (
        <AppPanel
            title="Next actions"
            description="Shortcuts for common branch operations."
            contentClassName="max-h-[312px] overflow-y-auto p-2 scrollbar-thin"
            className="h-full"
        >
            {loading && (
                <div className="space-y-2 p-2">
                    {[0, 1, 2].map((item) => (
                        <div key={item} className="h-14 animate-pulse rounded-[var(--ui-radius-control)] bg-[color:var(--ui-form-muted-surface-bg)]" />
                    ))}
                </div>
            )}

            {!loading && visibleActions.length === 0 && unavailableActions.length === 0 && (
                <p className={cn("px-3 py-4 text-sm", pageSubtleTextClass)}>No quick actions available for your access.</p>
            )}

            {!loading && (
                <div className="space-y-1">
                    {visibleActions.map(({ action }) => (
                        <Link
                            key={action.label}
                            href={`/branch/${branchId}${action.route}`}
                            className={cn("group flex w-full items-center gap-3 rounded-[var(--ui-radius-control)] border border-transparent px-3 py-2.5 text-left", pageInsetHoverClass)}
                        >
                            <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px]", action.tone)}>
                                <action.icon size={16} />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">{action.label}</p>
                                <p className={cn("truncate text-xs", pageSubtleTextClass)}>{action.description}</p>
                            </div>
                            <ArrowRight size={14} className="shrink-0 text-[color:var(--text-muted)] transition-colors group-hover:text-[color:var(--text-secondary)]" />
                        </Link>
                    ))}

                    {unavailableActions.map(({ action, decision }) => {
                        const helpText = decision.allowed ? "" : decision.reason;
                        return (
                            <div
                                key={`${action.label}-disabled`}
                                aria-disabled="true"
                                title={helpText}
                                className="flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-left opacity-70"
                            >
                                <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px]", pageInsetSurfaceClass, pageSubtleTextClass)}>
                                    <action.icon size={16} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className={cn("truncate text-sm font-medium", pageMutedTextClass)}>{action.label}</p>
                                    <p className={cn("truncate text-xs", pageSubtleTextClass)}>{helpText}</p>
                                </div>
                                <LockKeyhole size={14} className="shrink-0 text-[color:var(--text-muted)]" />
                                {!decision.allowed && decision.recoveryHref && (
                                    <Link
                                        href={decision.recoveryHref}
                                        className="shrink-0 text-xs font-semibold text-cyan-300 underline-offset-4 hover:underline"
                                    >
                                        Restore
                                    </Link>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </AppPanel>
    );
}
