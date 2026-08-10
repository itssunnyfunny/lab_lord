import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BranchService } from "@/services/branch.service";
import { OrganizationService } from "@/services/organization.service";
import { validateRequiredPhone, validateRequiredText } from "@/lib/formValidation";
import { BillingReadOnlyError, SubscriptionEntitlementError } from "@/services/entitlement.service";
import { BillingWritesDisabledError } from "@/lib/billingFeature";
import { BillingChangeInProgressError } from "@/lib/billingErrors";
import { BillingService } from "@/services/billing.service";

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
        const idempotencyKey = req.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) {
            return NextResponse.json({ error: "Idempotency-Key is required" }, { status: 400 });
        }

        const body = await req.json();

        const nameResult = validateRequiredText(body.name, "Branch name", 120);
        if (!nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
        const contactPhoneResult = validateRequiredPhone(body.contactPhone, "Contact phone");
        if (!contactPhoneResult.ok) return NextResponse.json({ error: contactPhoneResult.error }, { status: 400 });

        const branch = await BranchService.createBranchForOrg({
            name: nameResult.value,
            organizationId: orgId,
            userId: user.id,
            contactPhone: contactPhoneResult.value,
            idempotencyKey,
        });
        const checkout = branch.action === "CHECKOUT_REQUIRED" && branch.billingChangeId
            ? (await BillingService.getBillingOperation(user.id, orgId, branch.billingChangeId)).checkout
            : undefined;

        return NextResponse.json({ ...branch, ...(checkout ? { checkout } : {}) }, {
            status: branch.billingStatus === "PENDING_ACTIVATION" ? 202 : 201,
        });
    } catch (error) {
        if (error instanceof SubscriptionEntitlementError || error instanceof BillingReadOnlyError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
        }
        if (error instanceof BillingWritesDisabledError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
        }
        if (error instanceof BillingChangeInProgressError) {
            return NextResponse.json(
                { error: error.message, code: error.code, existingChangeId: error.existingChangeId },
                { status: 409 }
            );
        }
        console.error("Error creating branch:", error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}
