import { NextRequest, NextResponse } from "next/server";
import { SeatAllocationService } from "@/services/seatAllocation.service";
import { getSessionUser } from "@/lib/auth";

// POST: Assign a seat
export async function POST(
    req: NextRequest,
    { params }: { params: { branchId: string } }
) {
    try {
        const user = await getSessionUser(); // Get user
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // We don't really use params.branchId anymore for the logic, 
        // because ownership is validated via the seat's branch organization owner.
        // But we keep it as route parameter.
        const body = await req.json();
        const { seatId, studentId, shiftId } = body;

        if (!seatId || !studentId || !shiftId) {
            return NextResponse.json(
                { error: "Missing required fields: seatId, studentId, shiftId" },
                { status: 400 }
            );
        }

        const allocation = await SeatAllocationService.assignSeat(
            user.id, // Pass userId
            seatId,
            studentId,
            shiftId
        );

        return NextResponse.json(allocation, { status: 201 });
    } catch (error: any) {
        return NextResponse.json(
            { error: error.message || "Failed to assign seat" },
            { status: 400 } // Using 400 as most errors are validation/logic errors
        );
    }
}

// GET: List allocations
export async function GET(
    req: NextRequest,
    { params }: { params: { branchId: string } }
) {
    try {
        const { branchId } = params;
        const { searchParams } = new URL(req.url);
        const studentId = searchParams.get("studentId") || undefined;
        const shiftId = searchParams.get("shiftId") || undefined;
        const activeOnly = searchParams.get("activeOnly") === "true";

        const allocations = await SeatAllocationService.listAllocations(branchId, {
            studentId,
            shiftId,
            activeOnly,
        });

        return NextResponse.json(allocations);
    } catch (error: any) {
        return NextResponse.json(
            { error: error.message || "Failed to list allocations" },
            { status: 500 }
        );
    }
}
