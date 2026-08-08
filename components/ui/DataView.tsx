import type { ReactNode } from "react";
import type { ResourceState } from "@/types";
import { ErrorState } from "./ErrorState";
import { LoadingTableSkeleton } from "./LoadingSkeleton";

export function DataView<T>({
    state,
    children,
    empty,
    loadingLabel = "Loading data",
    onRetry,
}: {
    state: ResourceState<T>;
    children: (data: T, stale: boolean) => ReactNode;
    empty: ReactNode;
    loadingLabel?: string;
    onRetry?: () => void;
}) {
    switch (state.status) {
        case "loading":
            return state.previous ? <>{children(state.previous, true)}</> : (
                <div role="status" aria-label={loadingLabel}>
                    <span className="sr-only">{loadingLabel}</span>
                    <LoadingTableSkeleton />
                </div>
            );
        case "success":
            return <>{children(state.data, false)}</>;
        case "stale":
            return (
                <div>
                    <div role="status" className="mb-3 rounded-md border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
                        {state.reason} Last updated {new Date(state.updatedAt).toLocaleString()}.
                    </div>
                    {children(state.data, true)}
                </div>
            );
        case "empty":
            return <>{empty}</>;
        case "restricted":
            return <ErrorState restricted title="Access restricted" description={state.reason} />;
        case "error":
            return <ErrorState title="Data unavailable" description={state.message} onRetry={state.retryable ? onRetry : undefined} />;
    }
}
