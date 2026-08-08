import { NextRequest, NextResponse } from "next/server";
import { StaffService } from "@/services/staff.service";
import { getSessionUser } from "@/lib/auth";
import { StaffRole } from "@/types";
import { SubscriptionEntitlementError } from "@/services/entitlement.service";
import {
    decodeDateIdCursor,
    PaginationInputError,
    parsePageLimit,
} from "@/lib/cursorPagination";

function isStaffRole(role: unknown): role is StaffRole {
    return role === StaffRole.MANAGER || role === StaffRole.STAFF;
}

// GET: List staff of a branch
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

        const limit = parsePageLimit(req.nextUrl.searchParams.get("limit"));
        const cursor = decodeDateIdCursor(req.nextUrl.searchParams.get("cursor"));
        const staffMembers = await StaffService.listStaffPage(user.id, branchId, {
            cursor,
            limit,
        });
        return NextResponse.json(staffMembers);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to list staff";
        const status = error instanceof PaginationInputError
            ? 400
            : error instanceof SubscriptionEntitlementError || message.includes("Unauthorized")
                ? 403
                : 500;
        return NextResponse.json(
            { error: message },
            { status }
        );
    }
}

// POST: Add staff to a branch
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

        const body = await req.json();
        const { email, role } = body;

        if (!email || !role) {
            return NextResponse.json(
                { error: "Missing required fields: email, role" },
                { status: 400 }
            );
        }

        if (typeof email !== "string" || !isStaffRole(role)) {
            return NextResponse.json(
                { error: "Invalid email or role" },
                { status: 400 }
            );
        }

        const newStaff = await StaffService.addStaffByEmail(user.id, branchId, email, role);
        return NextResponse.json(newStaff, { status: 201 });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to add staff";
        return NextResponse.json(
            { error: message },
            { status: error instanceof SubscriptionEntitlementError ? 403 : 400 }
        );
    }
}
