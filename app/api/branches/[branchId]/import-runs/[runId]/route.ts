import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportRunService } from "@/importing/services/import-run.service";

type Params = { params: Promise<{ branchId: string; runId: string }> };

export async function GET(_req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, runId } = await params;
        return NextResponse.json(await ImportRunService.getRunProgress(user.id, branchId, runId));
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to load import progress.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
