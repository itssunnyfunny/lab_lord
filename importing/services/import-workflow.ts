import type { ImportRunKind } from "@/app/generated/prisma/enums";
import { getRun as getWorkflowRun, start } from "workflow/api";
import { ImportRunService } from "./import-run.service";
import {
    executeImportAnalysisWorkflow,
    executeImportCommitWorkflow,
} from "../workflows/import-assistance";

export class ImportWorkflowService {
    static async startRun(run: { id: string; kind: ImportRunKind; workflowRunId: string | null; status: string }) {
        if (["COMPLETED", "COMPLETED_WITH_ISSUES", "PERMANENT_FAILURE", "CANCELLED", "SUPERSEDED", "CANCEL_REQUESTED", "WAITING_FOR_USER"].includes(run.status)) {
            return run;
        }

        let dispatchableRun = run;
        if (dispatchableRun.workflowRunId) {
            const attachedWorkflowRunId = dispatchableRun.workflowRunId;
            const providerRun = getWorkflowRun(attachedWorkflowRunId);
            const exists = await providerRun.exists;
            const providerStatus = exists ? await providerRun.status : "missing";
            if (providerStatus === "pending" || providerStatus === "running") {
                return dispatchableRun;
            }

            // The provider run is terminal (or no longer exists), while the
            // PostgreSQL ledger is still active. Fence that provider owner
            // before re-dispatch. If another request already won the fence,
            // return its attachment instead of starting a third workflow.
            dispatchableRun = await ImportRunService.releaseWorkflowRunForRedispatch({
                importRunId: dispatchableRun.id,
                expectedWorkflowRunId: attachedWorkflowRunId,
            });
            if (dispatchableRun.workflowRunId) return dispatchableRun;
        }

        const workflowRun = run.kind === "ANALYSIS"
            ? await start(executeImportAnalysisWorkflow, [dispatchableRun.id])
            : await start(executeImportCommitWorkflow, [dispatchableRun.id]);
        return ImportRunService.attachWorkflowRun({
            importRunId: dispatchableRun.id,
            workflowRunId: workflowRun.runId,
        });
    }

    static async tryStartRun(run: { id: string; kind: ImportRunKind; workflowRunId: string | null; status: string }) {
        try {
            const started = await this.startRun(run);
            return {
                run: started,
                dispatchPending: false,
                workflowAttached: Boolean(started.workflowRunId),
                dispatchRequired: false,
            };
        } catch {
            // The PostgreSQL ledger is authoritative. A later idempotent
            // analyze request can re-dispatch this same unattached run.
            console.error("[IMPORT_WORKFLOW_DISPATCH_PENDING]", {
                code: "IMPORT_WORKFLOW_DISPATCH_PENDING",
                importRunId: run.id,
                kind: run.kind,
            });
            const latestRun = await ImportRunService.getWorkflowDispatchState(run.id).catch(() => run);
            return {
                run: latestRun,
                dispatchPending: true,
                workflowAttached: Boolean(latestRun.workflowRunId),
                dispatchRequired: ["QUEUED", "RUNNING", "RETRYABLE_FAILURE"].includes(latestRun.status),
            };
        }
    }
}
