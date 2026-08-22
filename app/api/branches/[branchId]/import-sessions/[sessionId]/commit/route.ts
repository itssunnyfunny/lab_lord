import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertImportV2Enabled } from "@/lib/importFeature";
import { toImportApiError } from "@/importing/http/import-api-error";
import { readImportJson } from "@/importing/http/import-request";
import { ImportPlanService } from "@/importing/services/import-plan.service";
import { ImportRunService } from "@/importing/services/import-run.service";
import { ImportWorkflowService } from "@/importing/services/import-workflow";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };

export async function POST(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        assertImportV2Enabled();
        const { branchId, sessionId } = await params;
        const body = await readImportJson<{ planId?: unknown; confirmed?: unknown }>(req);
        if (body.confirmed !== true) throw new Error("Final confirmation is required.");
        if (typeof body.planId !== "string" || !body.planId.trim()) {
            throw new Error("Reviewed import plan id is required.");
        }
        const idempotencyKey = req.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) throw new Error("Idempotency-Key is required.");

        const plan = await ImportPlanService.getPlanForCommit(
            user.id,
            branchId,
            sessionId,
            body.planId.trim()
        );
        const run = await ImportRunService.createOrGetRun({
            userId: user.id,
            branchId,
            sessionId,
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
        const apiError = toImportApiError(error, "Failed to start the import.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
