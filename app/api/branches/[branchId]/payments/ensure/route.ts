import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { PaymentService } from "@/services/payment.service";

function statusForError(message: string) {
    if (message.includes("not found")) return 404;
    if (message.includes("Unauthorized")) return 403;
    return 500;
}

export async function POST(
    _request: Request,
    { params }: { params: Promise<{ branchId: string }> }
) {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { branchId } = await params;
        const result = await PaymentService.generateDuePaymentsForBranch(user.id, branchId);
        return NextResponse.json(result);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: statusForError(message) });
    }
}
