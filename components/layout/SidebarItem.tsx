"use client";

import { cn } from "@/lib/utils";
import { LockKeyhole, LucideIcon } from "lucide-react";
import React from "react";

interface SidebarItemProps {
    icon: LucideIcon;
    label: string;
    isActive: boolean;
    onClick?: () => void;
    isCollapsed?: boolean;
    density?: "default" | "compact";
    locked?: boolean;
    badge?: string;
}

export const SidebarItem = ({ icon: Icon, label, isActive, onClick, isCollapsed, density = "default", locked = false, badge }: SidebarItemProps) => (
    <button
        onClick={onClick}
        aria-current={isActive ? "page" : undefined}
        className={cn(
            "group relative flex w-full items-center text-left transition-all duration-300",
            density === "compact"
                ? "h-9 gap-2.5 rounded-lg border px-2.5"
                : "gap-3 rounded-xl border px-3 py-2.5",
            isActive
                ? density === "compact"
                    ? "border-[color:var(--ui-form-input-focus-border)] bg-[color:var(--ui-form-input-bg)] text-[color:var(--text-primary)]"
                    : "border border-[color:var(--ui-form-input-focus-border)] bg-[color:var(--ui-form-input-bg)] text-[color:var(--text-primary)]"
                : density === "compact"
                    ? "border-transparent text-[color:var(--text-secondary)] hover:border-[color:var(--ui-form-surface-border)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
                    : "border-transparent text-[color:var(--text-secondary)] hover:border-[color:var(--ui-form-surface-border)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
        )}
    >
        <Icon
            size={density === "compact" ? 17 : 20}
            className={cn(
                "shrink-0 transition-colors duration-300",
                isActive
                    ? "text-[color:var(--ui-form-accent)]"
                    : "group-hover:text-[color:var(--ui-form-accent-hover)]"
            )}
        />
        {!isCollapsed && (
            <span className={cn(
                "min-w-0 flex-1 truncate font-medium tracking-wide",
                density === "compact" ? "text-[13px]" : "text-sm"
            )}>
                {label}
            </span>
        )}
        {isActive && <div className={cn(
            "absolute left-0 top-1/2 w-0.5 -translate-y-1/2",
            density === "compact" ? "h-4 bg-[color:var(--ui-form-accent)]" : "h-6 bg-[color:var(--ui-form-accent)]"
        )} />}
        {!isCollapsed && locked && <LockKeyhole size={13} className="shrink-0 text-amber-500" aria-label="Standard plan required" />}
        {!isCollapsed && badge && <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-600">{badge}</span>}
    </button>
);
