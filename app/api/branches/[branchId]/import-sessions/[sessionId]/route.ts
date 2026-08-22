import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportRequestError } from "@/importing/http/import-request";
import { ImportSessionService, type ImportSessionRowFilter } from "@/importing/services/import-session.service";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };

function rowFilterFrom(value: string | null): ImportSessionRowFilter | undefined {
    if (value === "attention" || value === "ready" || value === "all" || value === "skipped") return value;
    return undefined;
}

function numberFrom(value: string | null) {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function issueCodeFrom(value: string | null) {
    if (value === null) return undefined;
    const issueCode = value.trim();
    if (!issueCode || issueCode.length > 100 || !/^[A-Z0-9_:-]+$/.test(issueCode)) {
        throw new ImportRequestError("Import row issue filter is invalid.", { code: "INVALID_ROW_ISSUE_FILTER" });
    }
    return issueCode;
}

export async function GET(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, sessionId } = await params;
        const { searchParams } = new URL(req.url);
        const detail = await ImportSessionService.getSessionDetail(user.id, branchId, sessionId, {
            rowFilter: rowFilterFrom(searchParams.get("rowFilter")),
            issueCode: issueCodeFrom(searchParams.get("issueCode")),
            limit: numberFrom(searchParams.get("limit")),
            cursor: numberFrom(searchParams.get("cursor")),
        });
        return NextResponse.json(detail);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to get import session.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
