"use client";

import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

export type StatCardTone = "neutral" | "success" | "warning" | "danger" | "info";
export type StatCardAccent = "neutral" | "emerald" | "rose" | "cyan" | "violet";

interface StatCardProps {
    title: string;
    value: string;
    sub: string;
    icon: LucideIcon;
    tone?: StatCardTone;
    accent?: StatCardAccent;
    alert?: boolean;
    progress?: number;
    footer?: string;
}

const toneMap = {
    neutral: {
        progress: "bg-[color:var(--ui-tone-neutral-progress)]",
    },
    success: {
        progress: "bg-[color:var(--ui-tone-success-progress)]",
    },
    warning: {
        progress: "bg-[color:var(--ui-tone-warning-progress)]",
    },
    danger: {
        progress: "bg-[color:var(--ui-tone-danger-progress)]",
    },
    info: {
        progress: "bg-[color:var(--ui-tone-info-progress)]",
    },
};

const accentMap = {
    neutral: {
        border: "border-[color:var(--ui-panel-border)]",
        wash: "hidden",
        icon: "bg-[color:var(--ui-tone-neutral-bg)] text-[color:var(--ui-tone-neutral-text)]",
        value: "text-[color:var(--ui-stat-value)]",
    },
    emerald: {
        border: "border-emerald-400/20",
        wash: "bg-[radial-gradient(circle_at_top_right,rgba(52,211,153,0.11),transparent_48%)]",
        icon: "bg-emerald-400/10 text-emerald-200",
        value: "text-emerald-200",
    },
    rose: {
        border: "border-rose-400/20",
        wash: "bg-[radial-gradient(circle_at_top_right,rgba(251,113,133,0.11),transparent_48%)]",
        icon: "bg-rose-400/10 text-rose-200",
        value: "text-rose-200",
    },
    cyan: {
        border: "border-cyan-400/20",
        wash: "bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.11),transparent_48%)]",
        icon: "bg-cyan-400/10 text-cyan-200",
        value: "text-cyan-200",
    },
    violet: {
        border: "border-violet-400/20",
        wash: "bg-[radial-gradient(circle_at_top_right,rgba(167,139,250,0.12),transparent_48%)]",
        icon: "bg-violet-400/10 text-violet-200",
        value: "text-violet-200",
    },
} satisfies Record<StatCardAccent, {
    border: string;
    wash: string;
    icon: string;
    value: string;
}>;

export function StatCard({
    title,
    value,
    sub,
    icon: Icon,
    tone = "neutral",
    accent = "neutral",
    alert,
    progress,
    footer,
}: StatCardProps) {
    const statusStyle = toneMap[tone];
    const identityStyle = accentMap[accent];
    const progressValue = typeof progress === "number" ? Math.max(0, Math.min(progress, 100)) : null;

    return (
        <div
            data-accent={accent}
            data-tone={tone}
            className={cn(
                "relative overflow-hidden rounded-[var(--ui-radius-panel)] border bg-[color:var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)]",
                identityStyle.border
            )}
        >
            <span aria-hidden="true" className={cn("pointer-events-none absolute inset-0", identityStyle.wash)} />
            <div className="relative flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-xs font-medium text-[color:var(--ui-stat-title)]">{title}</p>
                    <p className={cn("mt-2 break-words text-2xl font-semibold tracking-tight", identityStyle.value)}>{value}</p>
                    <p className="mt-1 text-xs leading-5 text-[color:var(--ui-stat-subtitle)]">{sub}</p>
                </div>
                <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)]", identityStyle.icon)}>
                    <Icon size={17} />
                </div>
            </div>

            {progressValue !== null && (
                <div className="relative mt-4">
                    <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--ui-stat-track)]">
                        <div className={cn("h-full rounded-full", statusStyle.progress)} style={{ width: `${progressValue}%` }} />
                    </div>
                    {footer && <p className="mt-2 text-[11px] text-[color:var(--ui-stat-subtitle)]">{footer}</p>}
                </div>
            )}

            {alert && progressValue === null && (
                <div className="relative mt-4 flex items-center gap-2 text-[11px] font-medium text-[color:var(--ui-stat-alert)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--ui-stat-alert-dot)]" />
                    Needs attention
                </div>
            )}
        </div>
    );
}
