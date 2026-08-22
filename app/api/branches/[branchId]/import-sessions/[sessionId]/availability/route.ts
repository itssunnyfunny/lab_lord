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
        if (typeof body.rowId !== "string") {
            return NextResponse.json({ error: "rowId is required." }, { status: 400 });
        }

        const availability = await ImportWiringService.getAvailability(user.id, branchId, sessionId, {
            rowId: body.rowId,
            shiftIds: Array.isArray(body.shiftIds) ? body.shiftIds.filter((id: unknown): id is string => typeof id === "string") : [],
            multiShiftId: typeof body.multiShiftId === "string" ? body.multiShiftId : null,
        });
        return NextResponse.json(availability);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to load import availability.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
