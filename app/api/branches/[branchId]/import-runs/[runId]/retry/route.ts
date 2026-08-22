import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertImportV2Enabled } from "@/lib/importFeature";
import { toImportApiError } from "@/importing/http/import-api-error";
import { readImportJson } from "@/importing/http/import-request";
import { ImportPlanService } from "@/importing/services/import-plan.service";
import { ImportRunService } from "@/importing/services/import-run.service";
import { ImportWorkflowService } from "@/importing/services/import-workflow";

type Params = { params: Promise<{ branchId: string; runId: string }> };
const RETRYABLE_RUN_STATUSES = new Set(["RETRYABLE_FAILURE", "COMPLETED_WITH_ISSUES", "PERMANENT_FAILURE"]);

export async function POST(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        assertImportV2Enabled();
        const { branchId, runId } = await params;
        const body = await readImportJson<{ planId?: unknown; confirmed?: unknown }>(req);
        if (body.confirmed !== true || typeof body.planId !== "string" || !body.planId.trim()) {
            throw new Error("A newly reviewed plan and confirmation are required to retry unresolved rows.");
        }
        const idempotencyKey = req.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) throw new Error("Idempotency-Key is required.");
        const previous = await ImportRunService.getRunProgress(user.id, branchId, runId);
        if (!previous.importSessionId || !RETRYABLE_RUN_STATUSES.has(previous.status)) {
            throw new Error("This import run cannot be retried.");
        }
        const plan = await ImportPlanService.getPlanForCommit(
            user.id,
            branchId,
            previous.importSessionId,
            body.planId.trim()
        );
        if (plan.id === previous.importPlanId || plan.revision <= previous.targetRevision) {
            throw new Error("Repair unresolved rows and review a new plan before retrying.");
        }
        const run = await ImportRunService.createOrGetRun({
            userId: user.id,
            branchId,
            sessionId: previous.importSessionId,
            kind: "COMMIT",
            importPlanId: plan.id,
            confirmedPlanVersion: plan.planVersion,
            targetRevision: plan.revision,
            idempotencyKey,
        });
        const dispatch = await ImportWorkflowService.tryStartRun(run);
        return NextResponse.json({
            runId: dispatch.run.id,
            status: dispatch.run.status,
            dispatchPending: dispatch.dispatchPending,
            workflowAttached: dispatch.workflowAttached,
            dispatchRequired: dispatch.dispatchRequired,
        }, { status: 202 });
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to retry unresolved import rows.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
