import { NextRequest, NextResponse } from "next/server";
import { SeatAllocationService } from "@/services/seatAllocation.service";
import { getSessionUser } from "@/lib/auth";

export async function POST(req: NextRequest) {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { seatId, studentId, shiftId } = body;

        if (!seatId || !studentId || !shiftId) {
            return NextResponse.json(
                { error: "Missing required fields: seatId, studentId, shiftId" },
                { status: 400 }
            );
        }

        const allocation = await SeatAllocationService.assignSeat(
            user.id,
            seatId,
            studentId,
            shiftId
        );

        return NextResponse.json(allocation, { status: 201 });
    } catch (error: any) {
        const status = error.message.includes("Unauthorized") ? 403 : 400;
        return NextResponse.json(
            { error: error.message || "Failed to assign seat" },
            { status }
        );
    }
}
