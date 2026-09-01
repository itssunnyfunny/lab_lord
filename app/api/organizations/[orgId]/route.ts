import { NextRequest, NextResponse } from "next/server";
import { OrganizationService } from "@/services/organization.service";
import { getSessionUser } from "@/lib/auth";
import { BillingReadOnlyError } from "@/services/entitlement.service";
import {
    OrganizationAccessNotFoundError,
    OrganizationValidationError,
} from "@/lib/organizationErrors";

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
        if (error instanceof OrganizationAccessNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
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
        if (error instanceof BillingReadOnlyError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
        }
        if (error instanceof OrganizationAccessNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        if (error instanceof OrganizationValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
