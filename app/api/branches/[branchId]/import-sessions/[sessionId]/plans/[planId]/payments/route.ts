import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertImportV2Enabled } from "@/lib/importFeature";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportPlanService } from "@/importing/services/import-plan.service";

type Params = { params: Promise<{ branchId: string; sessionId: string; planId: string }> };

export async function GET(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        assertImportV2Enabled();
        const { branchId, sessionId, planId } = await params;
        const query = new URL(req.url).searchParams;
        const rawLimit = query.get("limit");
        if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
            throw new Error("Import payment detail page size is invalid");
        }
        const cursor = query.get("cursor") ?? undefined;
        return NextResponse.json(await ImportPlanService.getPaymentDetails(
            user.id,
            branchId,
            sessionId,
            planId,
            {
                cursor,
                limit: rawLimit === null ? undefined : Number(rawLimit),
            }
        ));
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to load import payment details.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
