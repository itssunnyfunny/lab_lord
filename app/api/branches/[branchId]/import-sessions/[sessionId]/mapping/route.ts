import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ImportSessionService } from "@/importing/services/import-session.service";
import { parseExpectedImportRevision, readImportJson } from "@/importing/http/import-request";
import { parseImportMappingMutation } from "@/importing/http/import-mapping-request";
import { toImportApiError } from "@/importing/http/import-api-error";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };

export async function PATCH(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, sessionId } = await params;
        const body = await readImportJson<{
            expectedRevision?: unknown;
            columnMappings?: unknown;
            importOptions?: unknown;
        }>(req);
        const mutation = parseImportMappingMutation(body);
        const detail = await ImportSessionService.updateMapping(user.id, branchId, sessionId, {
            expectedRevision: parseExpectedImportRevision(body.expectedRevision),
            ...mutation,
        });
        return NextResponse.json(detail);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to update mapping.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
