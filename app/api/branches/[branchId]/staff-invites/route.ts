import { NextRequest, NextResponse } from "next/server";
import { StaffInviteService } from "@/services/staffInvite.service";
import { getSessionUser } from "@/lib/auth";
import { StaffRole } from "@/types";
import { validateOptionalEmail } from "@/lib/formValidation";

function isStaffRole(role: unknown): role is StaffRole {
    return role === StaffRole.MANAGER || role === StaffRole.STAFF;
}

function getStatusForError(message: string) {
    if (message.includes("Unauthorized")) return 403;
    if (message.includes("not found")) return 404;
    if (message.includes("expiry") || message.includes("role")) return 400;
    return 500;
}

function toInviteResponse(invite: {
    id: string;
    role: StaffRole;
    token: string;
    expiresAt: Date;
    createdAt: Date;
}, origin: string) {
    return {
        id: invite.id,
        role: invite.role,
        token: invite.token,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
        inviteUrl: `${origin}/invite/${invite.token}`,
    };
}

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ branchId: string }> }
) {
    try {
        const { branchId } = await context.params;
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const origin = new URL(req.url).origin;
        const invites = await StaffInviteService.listActiveInvites(user.id, branchId);

        return NextResponse.json(invites.map(invite => toInviteResponse(invite, origin)));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to list invites";
        return NextResponse.json(
            { error: message },
            { status: getStatusForError(message) }
        );
    }
}

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ branchId: string }> }
) {
    try {
        const { branchId } = await context.params;
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const role = body.role;
        const invitedEmailResult = validateOptionalEmail(body.email, "Invite email");

        if (!isStaffRole(role)) {
            return NextResponse.json(
                { error: "Invalid role. Must be MANAGER or STAFF." },
                { status: 400 }
            );
        }

        if (!invitedEmailResult.ok || !invitedEmailResult.value) {
            return NextResponse.json(
                { error: invitedEmailResult.ok ? "Invite email is required." : invitedEmailResult.error },
                { status: 400 }
            );
        }

        const ttlDays = body.ttlDays === undefined ? undefined : Number(body.ttlDays);
        if (ttlDays !== undefined && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 30)) {
            return NextResponse.json(
                { error: "Invite expiry must be between 1 and 30 days." },
                { status: 400 }
            );
        }

        const invite = await StaffInviteService.createInvite(
            user.id,
            branchId,
            role,
            invitedEmailResult.value,
            ttlDays
        );
        const origin = new URL(req.url).origin;

        return NextResponse.json(toInviteResponse(invite, origin), { status: 201 });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to create invite";
        return NextResponse.json(
            { error: message },
            { status: getStatusForError(message) }
        );
    }
}
