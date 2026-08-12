import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { StaffInviteService } from "@/services/staffInvite.service";

function getStatusForError(message: string) {
    if (message.includes("different email")) return 403;
    if (message.includes("not found")) return 404;
    if (message.includes("already been accepted")) return 409;
    if (message.includes("expired") || message.includes("no longer supported")) return 410;
    if (message.includes("Unauthorized") || message.includes("subscription")) return 403;
    return 500;
}

export async function POST(
    _request: Request,
    context: { params: Promise<{ token: string }> }
) {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { token } = await context.params;
        const accepted = await StaffInviteService.acceptInvite(user.id, token);

        return NextResponse.json({
            branchId: accepted.branchId,
            destination: "/app",
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Could not accept invite";
        return NextResponse.json(
            { error: message },
            { status: getStatusForError(message) }
        );
    }
}
