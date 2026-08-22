import { NextResponse } from "next/server";
import type { ImportReadinessPolicy } from "@/app/generated/prisma/enums";
import type { ImportMutationSummary } from "@/importing/contracts/import-v2.contract";
import { getSessionUser } from "@/lib/auth";
import { assertImportV2Enabled } from "@/lib/importFeature";
import { toImportApiError } from "@/importing/http/import-api-error";
import { readImportJson } from "@/importing/http/import-request";
import { ImportPlanService } from "@/importing/services/import-plan.service";
import { ImportSessionService } from "@/importing/services/import-session.service";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };
const READINESS_POLICIES = new Set<ImportReadinessPolicy>(["READY_ROWS_ONLY", "REQUIRE_ALL_ROWS_READY"]);

export async function POST(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        assertImportV2Enabled();
        const { branchId, sessionId } = await params;
        const body = await readImportJson<{ readinessPolicy?: unknown; targetRevision?: unknown }>(req);
        const readinessPolicy = body.readinessPolicy ?? "READY_ROWS_ONLY";
        if (typeof readinessPolicy !== "string" || !READINESS_POLICIES.has(readinessPolicy as ImportReadinessPolicy)) {
            throw new Error("Import readiness policy is invalid.");
        }
        const detail = await ImportSessionService.getSessionDetail(user.id, branchId, sessionId, { limit: 1 });
        if (body.targetRevision !== undefined && typeof body.targetRevision !== "number") {
            throw new Error("Import target revision is invalid.");
        }
        const targetRevision = body.targetRevision === undefined ? detail.draftRevision : body.targetRevision;
        if (!Number.isInteger(targetRevision) || targetRevision < 0) {
            throw new Error("Import target revision is invalid.");
        }
        if (targetRevision !== detail.draftRevision) {
            const conflict = new Error("Import revision changed");
            Object.assign(conflict, { code: "IMPORT_REVISION_CONFLICT" });
            throw conflict;
        }
        const plan = await ImportPlanService.compilePlan({
            userId: user.id,
            branchId,
            sessionId,
            targetRevision,
            readinessPolicy: readinessPolicy as ImportReadinessPolicy,
        });
        const snapshot = plan.snapshot as {
            mutationSummary?: ImportMutationSummary;
            requiredPermissions?: unknown;
            configurationApproval?: unknown;
        };
        return NextResponse.json({
            id: plan.id,
            revision: plan.revision,
            readinessPolicy: plan.readinessPolicy,
            planVersion: plan.planVersion,
            canRun: plan.canRun,
            totalRows: plan.totalRows,
            readyRows: plan.readyRows,
            blockedRows: plan.blockedRows,
            warningRows: plan.warningRows,
            skippedRows: plan.skippedRows,
            checks: plan.checks,
            summary: plan.summary,
            mutationSummary: snapshot.mutationSummary,
            paymentDetails: {
                totalCycles: snapshot.mutationSummary?.paymentCycles ?? 0,
                affectedStudents: snapshot.mutationSummary?.affectedRows?.payments ?? 0,
                maxPageSize: 100,
            },
            requiredPermissions: snapshot.requiredPermissions,
            configurationApproval: snapshot.configurationApproval,
        }, { status: 201 });
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to build the reviewed import plan.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
