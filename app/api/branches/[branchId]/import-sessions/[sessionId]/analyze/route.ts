import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertImportV2Enabled } from "@/lib/importFeature";
import { toImportApiError } from "@/importing/http/import-api-error";
import { readImportJson } from "@/importing/http/import-request";
import { ImportRunService } from "@/importing/services/import-run.service";
import { ImportRunRunner } from "@/importing/services/import-runner.service";
import { ImportSessionService } from "@/importing/services/import-session.service";
import { ImportWorkflowService } from "@/importing/services/import-workflow";
import { createImportAnalysisRunIdentity } from "@/importing/utils/import-run-identity";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };

export async function POST(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, sessionId } = await params;
        const body = await readImportJson<{ confirmPdfExtraction?: unknown }>(req);
        const startState = await ImportSessionService.getAnalysisStartState(user.id, branchId, sessionId);

        if (startState.engineVersion === 1) {
            const detail = await ImportSessionService.analyzeSession(user.id, branchId, sessionId);
            return NextResponse.json(detail);
        }
        assertImportV2Enabled();
        const identity = createImportAnalysisRunIdentity({
            branchId,
            sessionId,
            targetRevision: startState.draftRevision,
        });
        let run = await ImportRunService.createOrGetRun({
            userId: user.id,
            branchId,
            sessionId,
            kind: "ANALYSIS",
            targetRevision: startState.draftRevision,
            idempotencyKey: identity.idempotencyKey,
        });
        const sourceConfiguration = startState.sourceConfiguration
            && typeof startState.sourceConfiguration === "object"
            && !Array.isArray(startState.sourceConfiguration)
            ? startState.sourceConfiguration as Record<string, unknown>
            : {};
        const pdfConfirmationRequired = startState.sourceType === "PDF"
            && sourceConfiguration.pdfConfirmed !== true;
        if (pdfConfirmationRequired && run.status === "QUEUED" && !run.workflowRunId) {
            run = await ImportRunRunner.setAnalysisStatus({
                importRunId: run.id,
                status: "WAITING_FOR_USER",
            });
        }
        if (body.confirmPdfExtraction === true) {
            run = await ImportRunService.confirmPdfExtraction(user.id, branchId, sessionId);
        }
        if (run.status === "WAITING_FOR_USER" && body.confirmPdfExtraction !== true) {
            return NextResponse.json({
                error: "Confirm the PDF text extraction preview before analysis.",
                code: "IMPORT_PDF_CONFIRMATION_REQUIRED",
                runId: run.id,
                status: run.status,
            }, { status: 409 });
        }
        const dispatch = await ImportWorkflowService.tryStartRun(run);
        return NextResponse.json({
            runId: dispatch.run.id,
            status: dispatch.run.status,
            dispatchPending: dispatch.dispatchPending,
            workflowAttached: dispatch.workflowAttached,
            dispatchRequired: dispatch.dispatchRequired,
        }, { status: 202 });
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to analyze import session.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
