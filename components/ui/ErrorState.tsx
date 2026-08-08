import { AlertCircle, LockKeyhole, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AppButton } from "./AppButton";

export function ErrorState({
    title,
    description,
    onRetry,
    retryLabel = "Try again",
    action,
    restricted = false,
    className,
}: {
    title: string;
    description: string;
    onRetry?: () => void;
    retryLabel?: string;
    action?: ReactNode;
    restricted?: boolean;
    className?: string;
}) {
    const Icon: LucideIcon = restricted ? LockKeyhole : AlertCircle;
    return (
        <section
            role={restricted ? "region" : "alert"}
            aria-label={title}
            className={cn(
                "flex min-h-48 flex-col items-center justify-center rounded-[var(--ui-radius-panel)] border border-dashed border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] px-5 py-8 text-center",
                className
            )}
        >
            <Icon className="h-6 w-6 text-amber-300" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-[color:var(--text-primary)]">{title}</h2>
            <p className="mt-1 max-w-md text-sm leading-6 text-[color:var(--text-secondary)]">{description}</p>
            {onRetry ? <AppButton className="mt-4" variant="secondary" onClick={onRetry}>{retryLabel}</AppButton> : null}
            {action ? <div className="mt-4">{action}</div> : null}
        </section>
    );
}
