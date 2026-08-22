import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ImportSessionService } from "@/importing/services/import-session.service";
import { ImportRequestError, parseExpectedImportRevision, readImportJson } from "@/importing/http/import-request";
import { toImportApiError } from "@/importing/http/import-api-error";
import type { ImportNormalizedRow } from "@/importing/contracts/import-session.contract";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };

function parseBulkRowAction(value: unknown) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ImportRequestError("Bulk row action is invalid.", { code: "INVALID_BULK_ROW_ACTION" });
    }
    const action = "action" in value ? value.action : undefined;
    const issueCode = "issueCode" in value ? value.issueCode : undefined;
    if (
        !["SKIP", "UNSKIP"].includes(String(action))
        || typeof issueCode !== "string"
        || !issueCode.trim()
        || issueCode.length > 100
        || !/^[A-Z0-9_:-]+$/.test(issueCode.trim())
    ) {
        throw new ImportRequestError("Bulk row action is invalid.", { code: "INVALID_BULK_ROW_ACTION" });
    }
    return { action: action as "SKIP" | "UNSKIP", issueCode: issueCode.trim() };
}

export async function PATCH(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, sessionId } = await params;
        const body = await readImportJson<{
            expectedRevision?: unknown;
            edits?: unknown;
            skipRowIds?: unknown;
            unskipRowIds?: unknown;
            bulkAction?: unknown;
        }>(req);
        const detail = await ImportSessionService.updateRows(user.id, branchId, sessionId, {
            expectedRevision: parseExpectedImportRevision(body.expectedRevision),
            edits: Array.isArray(body.edits) ? body.edits as { rowId: string; rawData?: Record<string, string>; normalizedData?: ImportNormalizedRow }[] : undefined,
            skipRowIds: Array.isArray(body.skipRowIds) ? body.skipRowIds.filter((id): id is string => typeof id === "string") : undefined,
            unskipRowIds: Array.isArray(body.unskipRowIds) ? body.unskipRowIds.filter((id): id is string => typeof id === "string") : undefined,
            bulkAction: parseBulkRowAction(body.bulkAction),
        });
        return NextResponse.json(detail);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to update rows.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
