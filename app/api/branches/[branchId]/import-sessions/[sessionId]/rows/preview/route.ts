import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportWiringService } from "@/importing/services/import-wiring.service";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };

export async function POST(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, sessionId } = await params;
        const body = await req.json();
        if (typeof body.rowId !== "string" || !body.normalizedData || typeof body.normalizedData !== "object") {
            return NextResponse.json({ error: "rowId and normalizedData are required." }, { status: 400 });
        }

        const preview = await ImportWiringService.previewRowDraft(user.id, branchId, sessionId, {
            rowId: body.rowId,
            normalizedData: body.normalizedData,
        });
        return NextResponse.json(preview);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to preview import row.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
