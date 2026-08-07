import { NextRequest, NextResponse } from "next/server";
import { StudentService } from "@/services/student.service";
import { getSessionUser } from "@/lib/auth";
import { StudentStatus } from "@/app/generated/prisma/enums";
import { isDueResolution } from "@/types";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalId,
    validateRequiredPhone,
    validateRequiredText,
} from "@/lib/formValidation";

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Something went wrong";
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ branchId: string }> }
) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { branchId } = await params;
        const body = await req.json();

        const nameResult = validateRequiredText(body.name, "Student name");
        if (!nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
        const phoneResult = validateRequiredPhone(body.phone);
        if (!phoneResult.ok) return NextResponse.json({ error: phoneResult.error }, { status: 400 });
        const monthlyFeeResult = parseIntegerField(body.monthlyFee, "Monthly fee", { min: 0, max: FORM_LIMITS.moneyMax });
        if (!monthlyFeeResult.ok) return NextResponse.json({ error: monthlyFeeResult.error }, { status: 400 });
        const admissionFeeResult = parseIntegerField(body.admissionFee, "Admission fee", { min: 0, max: FORM_LIMITS.moneyMax });
        if (!admissionFeeResult.ok) return NextResponse.json({ error: admissionFeeResult.error }, { status: 400 });
        const linkedShiftResult = validateOptionalId(body.feeLinkedShiftId, "Linked shift");
        if (!linkedShiftResult.ok) return NextResponse.json({ error: linkedShiftResult.error }, { status: 400 });
        const linkedMultiShiftResult = validateOptionalId(body.feeLinkedMultiShiftId, "Linked multi-shift");
        if (!linkedMultiShiftResult.ok) return NextResponse.json({ error: linkedMultiShiftResult.error }, { status: 400 });

        // Normalise shiftIds: accept array or singular (backward compat)
        const shiftIds: string[] | undefined =
            Array.isArray(body.shiftIds) && body.shiftIds.length > 0
                ? body.shiftIds
                : body.shiftId
                    ? [body.shiftId]
                    : undefined;

        const student = await StudentService.createStudent(user.id, branchId, {
            name: nameResult.value,
            phone: phoneResult.value,
            shiftIds,
            seatId: body.seatId,
            monthlyFee: monthlyFeeResult.value,
            admissionFee: admissionFeeResult.value,
            feeLinkedShiftId: linkedShiftResult.value,
            feeLinkedMultiShiftId: linkedMultiShiftResult.value,
        });

        return NextResponse.json(student, { status: 201 });
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        if (message.includes("Unauthorized")) return NextResponse.json({ error: message }, { status: 403 });
        if (message.includes("not found")) return NextResponse.json({ error: message }, { status: 404 });
        return NextResponse.json({ error: message }, { status: 400 });
    }
}


export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ branchId: string }> }
) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { branchId } = await params;
        const { searchParams } = new URL(req.url);
        const status = searchParams.get("status") as StudentStatus | undefined;
        const shiftId = searchParams.get("shiftId") || undefined;

        const students = await StudentService.getStudentsByBranch(user.id, branchId, { status, shiftId });
        return NextResponse.json(students);
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        if (message.includes("Unauthorized")) return NextResponse.json({ error: message }, { status: 403 });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function PATCH(
    req: NextRequest
) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const body = await req.json();

        if (!body.id) {
            return NextResponse.json({ error: "Student ID is required" }, { status: 400 });
        }

        // ── Path A: edit profile (name / phone)
        if (
            body.name !== undefined ||
            body.phone !== undefined ||
            body.monthlyFee !== undefined ||
            body.feeLinkedShiftId !== undefined ||
            body.feeLinkedMultiShiftId !== undefined
        ) {
            const nameResult = body.name !== undefined ? validateRequiredText(body.name, "Student name") : null;
            if (nameResult && !nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
            const phoneResult = body.phone !== undefined ? validateRequiredPhone(body.phone) : null;
            if (phoneResult && !phoneResult.ok) return NextResponse.json({ error: phoneResult.error }, { status: 400 });
            const monthlyFeeResult = body.monthlyFee !== undefined
                ? parseIntegerField(body.monthlyFee, "Monthly fee", { min: 0, max: FORM_LIMITS.moneyMax })
                : null;
            if (monthlyFeeResult && !monthlyFeeResult.ok) return NextResponse.json({ error: monthlyFeeResult.error }, { status: 400 });
            const linkedShiftResult = body.feeLinkedShiftId !== undefined
                ? validateOptionalId(body.feeLinkedShiftId, "Linked shift")
                : null;
            if (linkedShiftResult && !linkedShiftResult.ok) return NextResponse.json({ error: linkedShiftResult.error }, { status: 400 });
            const linkedMultiShiftResult = body.feeLinkedMultiShiftId !== undefined
                ? validateOptionalId(body.feeLinkedMultiShiftId, "Linked multi-shift")
                : null;
            if (linkedMultiShiftResult && !linkedMultiShiftResult.ok) return NextResponse.json({ error: linkedMultiShiftResult.error }, { status: 400 });

            const updated = await StudentService.updateStudentProfile(user.id, body.id, {
                ...(nameResult?.ok ? { name: nameResult.value } : {}),
                ...(phoneResult?.ok ? { phone: phoneResult.value ?? null } : {}),
                ...(monthlyFeeResult?.ok && monthlyFeeResult.value !== undefined ? { monthlyFee: monthlyFeeResult.value } : {}),
                ...(body.feeLinkedShiftId !== undefined
                    ? { feeLinkedShiftId: linkedShiftResult?.value ?? null }
                    : {}),
                ...(body.feeLinkedMultiShiftId !== undefined
                    ? { feeLinkedMultiShiftId: linkedMultiShiftResult?.value ?? null }
                    : {}),
            });

            return NextResponse.json(updated);
        }

        // ── Path B: change status
        if (!body.status) {
            return NextResponse.json(
                { error: "Provide profile/fee fields to edit, or status to change status" },
                { status: 400 }
            );
        }

        if (!Object.values(StudentStatus).includes(body.status)) {
            return NextResponse.json({ error: "Invalid status" }, { status: 400 });
        }

        const dueResolution = body.dueResolution === undefined ? "KEEP" : body.dueResolution;
        if (!isDueResolution(dueResolution)) {
            return NextResponse.json({ error: "Invalid due resolution" }, { status: 400 });
        }

        const student = await StudentService.updateStudentStatus(
            user.id,
            body.id,
            body.status as StudentStatus,
            dueResolution
        );
        return NextResponse.json(student);
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        if (message.includes("Unauthorized")) return NextResponse.json({ error: message }, { status: 403 });
        if (message.includes("not found")) return NextResponse.json({ error: message }, { status: 404 });
        return NextResponse.json({ error: message }, { status: 400 });
    }
}
