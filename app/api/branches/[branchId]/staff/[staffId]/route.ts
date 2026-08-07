import { NextRequest, NextResponse } from "next/server";
import { StaffService } from "@/services/staff.service";
import { getSessionUser } from "@/lib/auth";
import { StaffPermissionUpdate, StaffRole } from "@/types";
import { BillingReadOnlyError, SubscriptionEntitlementError } from "@/services/entitlement.service";

// DELETE: Remove staff from a branch
export async function DELETE(
    req: NextRequest,
    context: { params: Promise<{ branchId: string; staffId: string }> }
) {
    try {
        const { branchId, staffId } = await context.params;
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        await StaffService.removeStaff(user.id, branchId, staffId);
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to remove staff";
        const status = message.includes("not found") ? 404
            : error instanceof SubscriptionEntitlementError
                || error instanceof BillingReadOnlyError
                || message.includes("Unauthorized")
                ? 403
                : 400;
        return NextResponse.json(
            { error: message },
            { status }
        );
    }
}

// PATCH: Update a staff member's role and permission overrides
export async function PATCH(
    req: NextRequest,
    context: { params: Promise<{ branchId: string; staffId: string }> }
) {
    try {
        const { branchId, staffId } = await context.params;
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const body = await req.json();
        const { role, permissions } = body;

        if (role !== undefined && !Object.values(StaffRole).includes(role)) {
            return NextResponse.json({ error: "Invalid role. Must be MANAGER or STAFF." }, { status: 400 });
        }
        if (permissions !== undefined && (typeof permissions !== "object" || permissions === null || Array.isArray(permissions))) {
            return NextResponse.json({ error: "permissions must be an object" }, { status: 400 });
        }
        if (role === undefined && permissions === undefined) {
            return NextResponse.json({ error: "A role or permissions object is required." }, { status: 400 });
        }

        const updated = await StaffService.updateStaffAccess(user.id, branchId, staffId, {
            role: role as StaffRole | undefined,
            permissions: permissions as StaffPermissionUpdate | undefined,
        });
        return NextResponse.json(updated);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to update role";
        const status = message.includes("not found") ? 404
            : message.includes("Unauthorized") ? 403
                : 400;
        return NextResponse.json({ error: message }, { status });
    }
}
