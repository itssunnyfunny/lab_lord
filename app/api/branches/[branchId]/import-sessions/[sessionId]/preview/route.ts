import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportPreviewService } from "@/importing/services/import-preview.service";
import type { CommitMode } from "@/importing/contracts/import-session.contract";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };

export async function GET(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, sessionId } = await params;
        const { searchParams } = new URL(req.url);
        const mode = (searchParams.get("mode") || "SAFE_PARTIAL") as CommitMode;
        const preview = await ImportPreviewService.getPreview(user.id, branchId, sessionId, mode);
        return NextResponse.json(preview);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to build import preview.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
