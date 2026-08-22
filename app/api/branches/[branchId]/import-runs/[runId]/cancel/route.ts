import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportRunService } from "@/importing/services/import-run.service";

type Params = { params: Promise<{ branchId: string; runId: string }> };

export async function POST(_req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, runId } = await params;
        const run = await ImportRunService.requestCancel(user.id, branchId, runId);
        return NextResponse.json({ runId: run.id, status: run.status }, { status: 202 });
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to request import cancellation.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
