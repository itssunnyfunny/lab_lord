
import { NextResponse } from "next/server";
import { ShiftService } from "@/services/shift.service";

interface Params {
    params: Promise<{
        branchId: string;
    }>;
}

export async function GET(req: Request, { params }: Params) {
    try {
        const { branchId } = await params;
        const userId = req.headers.get("x-user-id");

        if (!userId) {
            return NextResponse.json(
                { error: "Unauthorized: x-user-id header missing" },
                { status: 401 }
            );
        }

        const shifts = await ShiftService.listShifts(userId, branchId);
        return NextResponse.json(shifts);
    } catch (error: any) {
        console.error("Error fetching shifts:", error);
        if (error.message.includes("Unauthorized") || error.message.includes("does not own")) {
            return NextResponse.json({ error: error.message }, { status: 403 });
        }
        if (error.message.includes("Branch not found")) {
            return NextResponse.json({ error: error.message }, { status: 404 });
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
        const userId = req.headers.get("x-user-id");

        if (!userId) {
            return NextResponse.json(
                { error: "Unauthorized: x-user-id header missing" },
                { status: 401 }
            );
        }

        const body = await req.json();

        if (!body.name) {
            return NextResponse.json(
                { error: "Name is required" },
                { status: 400 }
            );
        }

        const shift = await ShiftService.createShift(userId, branchId, {
            name: body.name,
            startTime: body.startTime,
            endTime: body.endTime,
        });

        return NextResponse.json(shift, { status: 201 });
    } catch (error: any) {
        console.error("Error creating shift:", error);
        if (error.message.includes("Unauthorized") || error.message.includes("does not own")) {
            return NextResponse.json({ error: error.message }, { status: 403 });
        }
        if (error.message.includes("already exists")) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}
