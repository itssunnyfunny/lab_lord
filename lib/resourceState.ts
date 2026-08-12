import type { ResourceState } from "@/types";

export function resourceData<T>(state: ResourceState<T>): T | undefined {
    if (state.status === "success" || state.status === "stale") return state.data;
    if (state.status === "loading") return state.previous;
    return undefined;
}

export function resourceUpdatedAt<T>(state: ResourceState<T>): string | undefined {
    if (state.status === "success" || state.status === "empty" || state.status === "stale") {
        return state.updatedAt;
    }
    if (state.status === "loading") return state.previousUpdatedAt;
    return undefined;
}

export function startResourceRefresh<T>(state: ResourceState<T>): ResourceState<T> {
    const previous = resourceData(state);
    const previousUpdatedAt = resourceUpdatedAt(state);
    return {
        status: "loading",
        ...(previous === undefined ? {} : { previous }),
        ...(previousUpdatedAt ? { previousUpdatedAt } : {}),
    };
}

export function failResourceRefresh<T>(
    state: ResourceState<T>,
    message: string,
    retryable = true
): ResourceState<T> {
    const data = resourceData(state);
    const updatedAt = resourceUpdatedAt(state);
    if (data !== undefined && updatedAt) {
        return { status: "stale", data, updatedAt, reason: message };
    }
    return { status: "error", message, retryable };
}
