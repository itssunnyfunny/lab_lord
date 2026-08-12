import { NextRequest, NextResponse } from "next/server";
import { OrganizationService } from "@/services/organization.service";
import { getSessionUser } from "@/lib/auth";
import { BillingReadOnlyError } from "@/services/entitlement.service";

/**
 * GET /api/organizations/[orgId]
 * Returns org details with branches.
 */
export async function GET(
    _req: NextRequest,
    context: { params: Promise<{ orgId: string }> }
) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { orgId } = await context.params;
        const org = await OrganizationService.getOrganizationForOwnerAccess(orgId, user.id);

        return NextResponse.json(org);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.includes("not found") ? 404
            : message.includes("Unauthorized") ? 403
                : 500;
        return NextResponse.json({ error: message }, { status });
    }
}

/**
 * PATCH /api/organizations/[orgId]
 * Updates org name and/or businessType. Owner only.
 */
export async function PATCH(
    req: NextRequest,
    context: { params: Promise<{ orgId: string }> }
) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { orgId } = await context.params;
        const updated = await OrganizationService.updateSettings(orgId, user.id, await req.json());

        return NextResponse.json(updated);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        if (error instanceof BillingReadOnlyError) {
            return NextResponse.json({ error: message, code: error.code }, { status: 403 });
        }
        const status = message.includes("not found") ? 404
            : message.includes("Unauthorized") ? 403
                : message.includes("Unknown") || message.includes("must") || message.includes("required") || message.includes("supported") ? 400
                    : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
