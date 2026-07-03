import { NextRequest, NextResponse } from "next/server";
import { StaffInviteService } from "@/services/staffInvite.service";
import { getSessionUser } from "@/lib/auth";
import { StaffRole } from "@/types";
import { checkRateLimit, getRequestRateLimitKey } from "@/lib/rateLimit";

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

        const rateLimitKey = getRequestRateLimitKey(req, `staff-invite-${branchId}`, user.id);
        const rateLimit = checkRateLimit(rateLimitKey, { limit: 5, windowMs: 60 * 1000 });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many requests" },
                { status: 429, headers: { "Retry-After": rateLimit.retryAfter.toString() } }
            );
        }

        const body = await req.json().catch(() => ({}));
        const role = body.role;

        if (!isStaffRole(role)) {
            return NextResponse.json(
                { error: "Invalid role. Must be MANAGER or STAFF." },
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

        const invite = await StaffInviteService.createInvite(user.id, branchId, role, ttlDays);
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
