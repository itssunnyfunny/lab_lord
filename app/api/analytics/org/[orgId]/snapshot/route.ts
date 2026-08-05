import { getOrganizationHealthSnapshot } from "@/analytics/org.analytics"
import { getSessionUser } from "@/lib/auth"
import { OrganizationService } from "@/services/organization.service"
import { EntitlementService, SubscriptionEntitlementError } from "@/services/entitlement.service"
import { NextResponse } from "next/server"

export async function GET(
    _: Request,
    { params }: { params: Promise<{ orgId: string }> }
) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const { orgId } = await params;
        const isOwner = await OrganizationService.isOwner(orgId, user.id)
        if (!isOwner) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }
        await EntitlementService.assertOrganizationEntitlement(orgId, "ADVANCED_ANALYTICS")

        const snapshot = await getOrganizationHealthSnapshot(orgId)
        return NextResponse.json(snapshot)
    } catch (error) {
        if (error instanceof SubscriptionEntitlementError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: 403 })
        }
        console.error("Error fetching organization snapshot:", error)
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        )
    }
}
