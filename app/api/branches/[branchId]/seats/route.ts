import { NextResponse } from "next/server";
import { SeatService } from "@/services/seat.service";
import { getSessionUser } from "@/lib/auth";
import { validateSeatLabel } from "@/lib/formValidation";
import {
    decodeDateIdCursor,
    PaginationInputError,
    parsePageLimit,
} from "@/lib/cursorPagination";

interface Params {
    params: Promise<{
        branchId: string;
    }>;
}

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Internal Server Error";
}

function parseAll(value: string | null) {
    if (value === null || value === "false") return false;
    if (value === "true") return true;
    throw new PaginationInputError("all must be true or false");
}

export async function GET(req: Request, { params }: Params) {
    try {
        const { branchId } = await params;
        const user = await getSessionUser();

        if (!user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 }
            );
        }

        const { searchParams } = new URL(req.url);
        const shiftId = searchParams.get("shiftId") || undefined;
        const cursorValue = searchParams.get("cursor");
        const limitValue = searchParams.get("limit");
        const all = parseAll(searchParams.get("all"));
        const cursor = decodeDateIdCursor(cursorValue);
        const limit = parsePageLimit(limitValue);

        if (all && (cursorValue || limitValue)) {
            throw new PaginationInputError("all cannot be combined with cursor or limit");
        }

        const seats = await SeatService.listSeats(user.id, branchId, {
            shiftId,
            cursor,
            limit,
            all,
        });
        return NextResponse.json(seats);
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        if (error instanceof PaginationInputError) {
            return NextResponse.json({ error: message }, { status: 400 });
        }
        console.error("Error fetching seats:", error);
        if (message.includes("Unauthorized") || message.includes("does not own")) {
            return NextResponse.json({ error: message }, { status: 403 });
        }
        if (message.includes("Branch not found")) {
            return NextResponse.json({ error: message }, { status: 404 });
        }
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}

export async function POST(req: Request, { params }: Params) {
    try {
        const { branchId } = await params;
        const user = await getSessionUser();

        if (!user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 }
            );
        }

        const body = await req.json();

        const labelResult = validateSeatLabel(body.label);
        if (!labelResult.ok) {
            return NextResponse.json(
                { error: labelResult.error },
                { status: 400 }
            );
        }

        const seat = await SeatService.createSeat(user.id, branchId, labelResult.value);

        return NextResponse.json(seat, { status: 201 });
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        console.error("Error creating seat:", error);
        if (message.includes("Unauthorized") || message.includes("does not own")) {
            return NextResponse.json({ error: message }, { status: 403 });
        }
        if (message.includes("already exists")) {
            return NextResponse.json({ error: message }, { status: 409 });
        }
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}
