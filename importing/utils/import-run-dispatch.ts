import type { ImportRunStatus } from "@/app/generated/prisma/enums";

const ATTACHED_WORKFLOW_RECONCILIATION_DELAY_MS = 60_000;

type ImportRunDispatchState = {
    status: ImportRunStatus | string;
    workflowRunId: string | null;
    lastHeartbeatAt?: Date | string | null;
    startedAt?: Date | string | null;
    updatedAt?: Date | string | null;
    createdAt?: Date | string | null;
};

function timestamp(value: Date | string | null | undefined) {
    if (!value) return null;
    const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
/**
 * Unattached queued/retryable runs need dispatch immediately. Attached runs
 * only need a provider-state reconciliation after the ledger has stopped
 * making progress, avoiding a provider lookup on every two-second UI poll.
 */
export function isImportRunDispatchRequired(
    run: ImportRunDispatchState,
    now = Date.now()
) {
    if (!["QUEUED", "RUNNING", "RETRYABLE_FAILURE"].includes(run.status)) return false;
    if (!run.workflowRunId) return run.status !== "RUNNING";
    if (run.status === "RETRYABLE_FAILURE") return true;

    const progressAt = timestamp(run.lastHeartbeatAt)
        ?? timestamp(run.startedAt)
        ?? timestamp(run.updatedAt)
        ?? timestamp(run.createdAt);
    return progressAt !== null
        && now - progressAt >= ATTACHED_WORKFLOW_RECONCILIATION_DELAY_MS;
}
