import { prisma } from "@/lib/prisma";
import { getWorkflowMetadata } from "workflow";
import { ImportRunExecutor, classifyImportRunError } from "../services/import-run-executor.service";
import { ImportRunService } from "../services/import-run.service";
import { ImportRunRunner } from "../services/import-runner.service";
import { ImportSessionService } from "../services/import-session.service";

const TERMINAL_RUN_STATUSES = new Set([
    "COMPLETED",
    "COMPLETED_WITH_ISSUES",
    "PERMANENT_FAILURE",
    "CANCELLED",
    "SUPERSEDED",
]);

type WorkflowProgress = {
    status: string;
    totalItems: number;
    completedItems: number;
    succeededItems: number;
    failedItems: number;
    skippedItems: number;
    cancelledItems: number;
};

/** Durable commit orchestration; only the PostgreSQL ledger id crosses Workflow. */
export async function executeImportCommitWorkflow(importRunId: string): Promise<WorkflowProgress> {
    "use workflow";

    try {
        if (!await attachImportWorkflowRun(importRunId)) {
            return await loadImportCommitProgress(importRunId);
        }
        let cursor = 0;
        while (cursor < 100_000) {
            const progress = await executeImportMutationBatch(importRunId, cursor);
            if (TERMINAL_RUN_STATUSES.has(progress.status)) return progress;
            cursor += 1;
        }
    } catch {
        // A step rejection reaches this boundary only after Workflow has
        // exhausted its configured retries. The ledger finalizer resolves
        // active leases/items without rolling back successful mutations.
        return finalizeExhaustedImportCommit(importRunId);
    }
    return finalizeExhaustedImportCommit(importRunId);
}

export async function finalizeExhaustedImportCommit(importRunId: string): Promise<WorkflowProgress> {
    "use step";
    return ImportRunRunner.finalizeExhaustedCommitRun(importRunId);
}

finalizeExhaustedImportCommit.maxRetries = 5;

export async function attachImportWorkflowRun(importRunId: string) {
    "use step";

    const workflowRunId = getWorkflowMetadata().workflowRunId;
    const run = await ImportRunService.attachWorkflowRun({ importRunId, workflowRunId });
    return run.workflowRunId === workflowRunId;
}

attachImportWorkflowRun.maxRetries = 5;

export async function loadImportCommitProgress(importRunId: string): Promise<WorkflowProgress> {
    "use step";
    return ImportRunRunner.finalizeRun(importRunId);
}

loadImportCommitProgress.maxRetries = 5;

/** One Workflow step applies no more than 25 persisted mutation items. */
export async function executeImportMutationBatch(importRunId: string, cursor: number): Promise<WorkflowProgress> {
    "use step";

    const workerId = `workflow:${importRunId}:${cursor}`;
    const items = await ImportRunRunner.claimBatch({
        importRunId,
        workerId,
        limit: 25,
    });
    for (const item of items) {
        try {
            await ImportRunExecutor.executeClaimedItem(item);
        } catch (error) {
            const failure = classifyImportRunError(error);
            await ImportRunRunner.failItem({
                importRunId,
                itemId: item.id,
                leaseToken: item.leaseToken,
                error: failure,
                retryDelayMilliseconds: 0,
            });
        }
    }
    return ImportRunRunner.finalizeRun(importRunId);
}

executeImportMutationBatch.maxRetries = 5;

/** Durable analysis orchestration. Source rows stay in PostgreSQL, not Workflow. */
export async function executeImportAnalysisWorkflow(importRunId: string): Promise<{
    status: string;
    revision: number | null;
}> {
    "use workflow";

    if (!await attachImportWorkflowRun(importRunId)) {
        return loadImportAnalysisProgress(importRunId);
    }
    try {
        return await executeImportAnalysis(importRunId);
    } catch {
        // A step rejection reaches this boundary only after Workflow has
        // exhausted executeImportAnalysis.maxRetries. Project that terminal
        // outcome into the PostgreSQL ledger so the session can be repaired
        // and later purged instead of remaining RETRYABLE_FAILURE forever.
        return finalizeExhaustedImportAnalysis(importRunId);
    }
}

export async function finalizeExhaustedImportAnalysis(importRunId: string) {
    "use step";

    const run = await ImportRunRunner.setAnalysisStatus({
        importRunId,
        status: "PERMANENT_FAILURE",
        error: {
            code: "IMPORT_ANALYSIS_RETRY_EXHAUSTED",
            message: "Import analysis could not complete after bounded retries.",
            retryable: false,
        },
    });
    const session = run.importSessionId
        ? await prisma.importSession.findUnique({
            where: { id: run.importSessionId },
            select: { activeEvaluationRevision: true },
        })
        : null;
    return {
        status: run.status,
        revision: session?.activeEvaluationRevision ?? null,
    };
}

finalizeExhaustedImportAnalysis.maxRetries = 5;

export async function loadImportAnalysisProgress(importRunId: string) {
    "use step";
    const run = await prisma.importRun.findUnique({
        where: { id: importRunId },
        select: {
            status: true,
            session: { select: { activeEvaluationRevision: true } },
        },
    });
    if (!run) throw new Error("Import analysis run not found");
    return { status: run.status, revision: run.session?.activeEvaluationRevision ?? null };
}

loadImportAnalysisProgress.maxRetries = 5;

export async function executeImportAnalysis(importRunId: string) {
    "use step";

    const run = await prisma.importRun.findUnique({
        where: { id: importRunId },
        select: {
            id: true,
            kind: true,
            branchId: true,
            importSessionId: true,
            requestedByUserId: true,
            status: true,
            targetRevision: true,
        },
    });
    if (!run || run.kind !== "ANALYSIS" || !run.importSessionId) {
        throw new Error("Import analysis run not found");
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
        const session = await prisma.importSession.findUnique({
            where: { id: run.importSessionId },
            select: { activeEvaluationRevision: true },
        });
        return { status: run.status, revision: session?.activeEvaluationRevision ?? null };
    }

    const currentSession = await prisma.importSession.findFirst({
        where: { id: run.importSessionId, branchId: run.branchId },
        select: { status: true, draftRevision: true, activeEvaluationRevision: true },
    });
    if (
        currentSession
        && currentSession.status !== "ANALYZING"
        && currentSession.activeEvaluationRevision !== null
        && currentSession.activeEvaluationRevision === currentSession.draftRevision
        && currentSession.activeEvaluationRevision >= run.targetRevision
    ) {
        await ImportRunRunner.setAnalysisStatus({ importRunId: run.id, status: "COMPLETED" });
        return { status: "COMPLETED", revision: currentSession.activeEvaluationRevision };
    }

    try {
        await ImportRunRunner.setAnalysisStatus({ importRunId: run.id, status: "RUNNING" });
        const detail = await ImportSessionService.analyzeSession(
            run.requestedByUserId,
            run.branchId,
            run.importSessionId,
            run.targetRevision
        );
        await ImportRunRunner.setAnalysisStatus({
            importRunId: run.id,
            status: "COMPLETED",
        });
        return {
            status: "COMPLETED",
            revision: detail.activeEvaluationRevision,
        };
    } catch (error) {
        const failure = classifyImportRunError(error);
        await ImportRunRunner.setAnalysisStatus({
            importRunId: run.id,
            status: failure.retryable ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
            error: failure,
        });
        if (failure.retryable) throw error;
        return { status: "PERMANENT_FAILURE", revision: null };
    }
}

executeImportAnalysis.maxRetries = 5;
