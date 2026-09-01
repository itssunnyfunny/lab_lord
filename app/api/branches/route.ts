import { NextResponse } from "next/server";
import { BranchService } from "@/services/branch.service";
import { OrganizationService } from "@/services/organization.service";
import { getSessionUser } from "@/lib/auth";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalText,
    validateRequiredPhone,
    validateRequiredText,
    validateShiftDrafts,
} from "@/lib/formValidation";
import { generateSeatLabelsForSeatCount, validateSeatNumberingConfig } from "@/lib/seatNumbering";
import { BillingReadOnlyError, SubscriptionEntitlementError } from "@/services/entitlement.service";
import { BillingWritesDisabledError } from "@/lib/billingFeature";
import { BillingChangeInProgressError } from "@/lib/billingErrors";
import { BillingService } from "@/services/billing.service";
import { billingHttpStatus } from "@/lib/billingHttp";

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Internal Server Error";
}

/**
 * POST /api/branches
 * Creates a new branch under an existing organization.
 * Shared with the onboarding flow's underlying logic via BranchService.createBranchForOrg.
 */
export async function POST(req: Request) {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { organizationId, name, contactPhone, city, defaultFee, seatCount, seatNumbering, shifts } = body;

        if (!organizationId || typeof organizationId !== "string") {
            return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
        }
        await OrganizationService.getOrganizationForOwnerAccess(organizationId, user.id);
        const idempotencyKey = req.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) {
            return NextResponse.json({ error: "Idempotency-Key is required" }, { status: 400 });
        }
        const nameResult = validateRequiredText(name, "Branch name", 120);
        if (!nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
        const contactPhoneResult = validateRequiredPhone(contactPhone, "Contact phone");
        if (!contactPhoneResult.ok) return NextResponse.json({ error: contactPhoneResult.error }, { status: 400 });
        const cityResult = validateOptionalText(city, "City", FORM_LIMITS.cityMax);
        if (!cityResult.ok) return NextResponse.json({ error: cityResult.error }, { status: 400 });
        const defaultFeeResult = parseIntegerField(defaultFee, "Default monthly fee", { min: 0, max: FORM_LIMITS.moneyMax });
        if (!defaultFeeResult.ok) return NextResponse.json({ error: defaultFeeResult.error }, { status: 400 });
        const seatCountResult = parseIntegerField(seatCount, "Total seats", { required: true, min: 1, max: FORM_LIMITS.seatsMax });
        if (!seatCountResult.ok) return NextResponse.json({ error: seatCountResult.error }, { status: 400 });
        const seatNumberingResult = validateSeatNumberingConfig(seatNumbering, seatCountResult.value);
        if (!seatNumberingResult.ok) return NextResponse.json({ error: seatNumberingResult.error }, { status: 400 });
        const seatLabelsResult = generateSeatLabelsForSeatCount(seatCountResult.value, seatNumberingResult.value);
        if (!seatLabelsResult.ok) return NextResponse.json({ error: seatLabelsResult.error }, { status: 400 });
        const shiftsResult = Array.isArray(shifts) ? validateShiftDrafts(shifts) : { ok: true as const, value: undefined };
        if (!shiftsResult.ok) return NextResponse.json({ error: shiftsResult.error }, { status: 400 });

        const branch = await BranchService.createBranchForOrg({
            organizationId,
            userId: user.id,
            name: nameResult.value,
            contactPhone: contactPhoneResult.value,
            city: cityResult.value,
            defaultFee: defaultFeeResult.value ?? 0,
            seatCount: seatCountResult.value,
            seatNumbering: seatNumberingResult.value,
            shifts: shiftsResult.value,
            idempotencyKey,
        });
        const checkout = branch.action === "CHECKOUT_REQUIRED" && branch.billingChangeId
            ? (await BillingService.getBillingOperation(
                user.id,
                organizationId,
                branch.billingChangeId
            )).checkout
            : undefined;

        return NextResponse.json(
            { ...branch, ...(checkout ? { checkout } : {}) },
            { status: branch.billingStatus === "PENDING_ACTIVATION" ? 202 : 201 }
        );
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        console.error("Error creating branch:", error);
        if (error instanceof SubscriptionEntitlementError || error instanceof BillingReadOnlyError) {
            return NextResponse.json({ error: message, code: error.code }, { status: 403 });
        }
        if (error instanceof BillingWritesDisabledError) {
            return NextResponse.json({ error: message, code: error.code }, { status: 503 });
        }
        if (error instanceof BillingChangeInProgressError) {
            return NextResponse.json(
                { error: message, code: error.code, existingChangeId: error.existingChangeId },
                { status: 409 }
            );
        }
        return NextResponse.json(
            { error: message },
            { status: billingHttpStatus(error) }
        );
    }
}
