import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BranchService } from "@/services/branch.service";
import { OrganizationService } from "@/services/organization.service";
import { validateRequiredPhone, validateRequiredText } from "@/lib/formValidation";
import { SubscriptionEntitlementError } from "@/services/entitlement.service";

// Correctly type the params as a Promise for Next.js 15+
interface Params {
    params: Promise<{
        orgId: string;
    }>;
}

export async function GET(_req: Request, { params }: Params) {
    try {
        const { orgId } = await params;
        const user = await getSessionUser();

        if (!user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 }
            );
        }

        const isOwner = await OrganizationService.isOwner(orgId, user.id);
        if (!isOwner) {
            return NextResponse.json(
                { error: "Forbidden: You do not own this organization" },
                { status: 403 }
            );
        }

        const branches = await BranchService.getBranchesByOrganizationId(orgId);
        return NextResponse.json(branches);
    } catch (error) {
        console.error("Error fetching branches:", error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}

export async function POST(req: Request, { params }: Params) {
    try {
        const { orgId } = await params;
        const user = await getSessionUser();

        if (!user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 }
            );
        }

        const isOwner = await OrganizationService.isOwner(orgId, user.id);
        if (!isOwner) {
            return NextResponse.json(
                { error: "Forbidden: You do not own this organization" },
                { status: 403 }
            );
        }

        const body = await req.json();

        const nameResult = validateRequiredText(body.name, "Branch name", 120);
        if (!nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
        const contactPhoneResult = validateRequiredPhone(body.contactPhone, "Contact phone");
        if (!contactPhoneResult.ok) return NextResponse.json({ error: contactPhoneResult.error }, { status: 400 });

        const branch = await BranchService.createBranch({
            name: nameResult.value,
            organizationId: orgId,
            contactPhone: contactPhoneResult.value,
        });

        return NextResponse.json(branch, { status: 201 });
    } catch (error) {
        if (error instanceof SubscriptionEntitlementError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
        }
        console.error("Error creating branch:", error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}
