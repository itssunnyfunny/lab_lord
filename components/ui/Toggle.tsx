"use client";

import { cn } from "@/lib/utils";

export function Toggle({
    checked,
    onCheckedChange,
    label,
    description,
    disabled = false,
    id,
    labelledBy,
    describedBy,
    className,
}: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    label: string;
    description?: string;
    disabled?: boolean;
    id?: string;
    labelledBy?: string;
    describedBy?: string;
    className?: string;
}) {
    return (
        <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            aria-label={labelledBy ? undefined : label}
            disabled={disabled}
            onClick={() => onCheckedChange(!checked)}
            className={cn(
                "flex min-h-11 w-full items-center justify-between gap-4 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] px-4 py-3 text-left transition-colors hover:bg-[color:var(--ui-form-surface-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                className
            )}
        >
            <span>
                <span className="block text-sm font-medium text-[color:var(--ui-form-label-strong)]">{label}</span>
                {description ? <span className="mt-0.5 block text-xs text-[color:var(--ui-text-muted)]">{description}</span> : null}
            </span>
            <span aria-hidden="true" className={cn("relative h-5 w-10 shrink-0 rounded-full transition-colors", checked ? "bg-[color:var(--ui-form-toggle-checked-bg)]" : "bg-[color:var(--ui-form-toggle-bg)]")}>
                <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-[color:var(--ui-form-toggle-thumb)] transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
            </span>
        </button>
    );
}
