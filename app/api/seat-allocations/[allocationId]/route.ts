import { NextRequest, NextResponse } from "next/server";
import { SeatAllocationService } from "@/services/seatAllocation.service";

// PUT: Release a seat (Unassign)
export async function PUT(
    req: NextRequest,
    { params }: { params: { allocationId: string } }
) {
    try {
        const { allocationId } = params;

        // We can accept a body if we want future extensibility, but for now just accessing the route is enough action.
        // However, to be RESTful and explicit, let's enforce a simple body check or just proceed.
        // The user requirement said: Body: { action: "RELEASE" } (or just simple PUT).
        // Let's support simple PUT for ease of use, but we can check the body if present.

        const releasedAllocation = await SeatAllocationService.unassignSeat(allocationId);

        return NextResponse.json(releasedAllocation);
    } catch (error: any) {
        return NextResponse.json(
            { error: error.message || "Failed to release seat" },
            { status: 400 }
        );
    }
}
