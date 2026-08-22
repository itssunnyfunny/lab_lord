import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertImportV2Enabled } from "@/lib/importFeature";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportRunService } from "@/importing/services/import-run.service";
import { ImportWorkflowService } from "@/importing/services/import-workflow";

type Params = { params: Promise<{ branchId: string; runId: string }> };

export async function POST(_req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        assertImportV2Enabled();
        const { branchId, runId } = await params;
        const run = await ImportRunService.getDispatchableRun(user.id, branchId, runId);
        const dispatch = await ImportWorkflowService.tryStartRun(run);
        return NextResponse.json({
            runId: dispatch.run.id,
            status: dispatch.run.status,
            dispatchPending: dispatch.dispatchPending,
            workflowAttached: dispatch.workflowAttached,
            dispatchRequired: dispatch.dispatchRequired,
        }, { status: 202 });
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to resume import processing.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
