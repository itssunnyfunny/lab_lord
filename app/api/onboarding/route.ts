import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { OnboardingService } from "@/services/onboarding.service";
import { checkRateLimit, getRequestRateLimitKey } from "@/lib/rateLimit";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalText,
    validateRequiredPhone,
    validateRequiredText,
    validateShiftDrafts,
} from "@/lib/formValidation";
import { generateSeatLabelsForSeatCount, validateSeatNumberingConfig } from "@/lib/seatNumbering";

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Failed to complete setup";
}

export async function POST(req: Request) {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const rateLimitKey = getRequestRateLimitKey(req, "onboarding", user.id);
        const rateLimit = checkRateLimit(rateLimitKey, { limit: 3, windowMs: 60 * 60 * 1000 });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many requests" },
                { status: 429, headers: { "Retry-After": rateLimit.retryAfter.toString() } }
            );
        }

        const body = await req.json();
        const { orgName, ownerPhone, businessType, branchName, city, defaultFee, seatCount, seatNumbering, shifts, multiShifts, includeFullTimeMultiShift } = body;

        const orgNameResult = validateRequiredText(orgName, "Organization name", 120);
        if (!orgNameResult.ok) return NextResponse.json({ error: orgNameResult.error }, { status: 400 });
        const ownerPhoneResult = validateRequiredPhone(ownerPhone, "Owner phone");
        if (!ownerPhoneResult.ok) return NextResponse.json({ error: ownerPhoneResult.error }, { status: 400 });
        const businessTypeResult = validateOptionalText(businessType, "Business type", 80);
        if (!businessTypeResult.ok) return NextResponse.json({ error: businessTypeResult.error }, { status: 400 });
        const branchNameResult = validateRequiredText(branchName, "Branch name", 120);
        if (!branchNameResult.ok) return NextResponse.json({ error: branchNameResult.error }, { status: 400 });
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
        if (multiShifts !== undefined && !Array.isArray(multiShifts)) {
            return NextResponse.json({ error: "Multi-shift selections are invalid." }, { status: 400 });
        }
        if (includeFullTimeMultiShift !== undefined && typeof includeFullTimeMultiShift !== "boolean") {
            return NextResponse.json({ error: "Full Time multi-shift selection is invalid." }, { status: 400 });
        }

        const result = await OnboardingService.createNetwork({
            userId: user.id,
            ownerPhone: ownerPhoneResult.value,
            orgData: {
                name: orgNameResult.value,
                businessType: businessTypeResult.value,
            },
            branchData: {
                name: branchNameResult.value,
                city: cityResult.value,
                defaultFee: defaultFeeResult.value ?? 0,
            },
            seatCount: seatCountResult.value,
            seatNumbering: seatNumberingResult.value,
            shifts: shiftsResult.value,
            multiShifts,
            includeFullTimeMultiShift,
        });

        return NextResponse.json(result, { status: 201 });
    } catch (error: unknown) {
        console.error("Onboarding Error:", error);
        return NextResponse.json(
            { error: getErrorMessage(error) },
            { status: 400 }
        );
    }
}
