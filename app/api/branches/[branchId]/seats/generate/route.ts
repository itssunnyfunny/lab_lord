import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { SeatService } from "@/services/seat.service";

interface Params {
    params: Promise<{
        branchId: string;
    }>;
}

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Internal Server Error";
}

export async function POST(req: Request, { params }: Params) {
    try {
        const { branchId } = await params;
        const user = await getSessionUser();

        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const seatNumbering = body && typeof body === "object" && !Array.isArray(body)
            ? (body as { seatNumbering?: unknown }).seatNumbering
            : undefined;
        const seats = await SeatService.generateSeats(user.id, branchId, seatNumbering);

        return NextResponse.json({
            created: seats.length,
            seats,
        }, { status: 201 });
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        console.error("Error generating seats:", error);
        if (message.includes("Unauthorized") || message.includes("does not own")) {
            return NextResponse.json({ error: message }, { status: 403 });
        }
        if (message.includes("Branch not found")) {
            return NextResponse.json({ error: message }, { status: 404 });
        }
        if (message.includes("already exists")) {
            return NextResponse.json({ error: message }, { status: 409 });
        }
        return NextResponse.json({ error: message }, { status: 400 });
    }
}
