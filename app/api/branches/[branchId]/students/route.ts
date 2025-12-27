import { NextRequest, NextResponse } from "next/server";
import { StudentService } from "@/services/student.service";
import { getSessionUser } from "@/lib/auth";

export async function POST(
    req: NextRequest,
    { params }: { params: { branchId: string } }
) {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { branchId } = params;
        const body = await req.json();

        if (!body.name) {
            return NextResponse.json(
                { error: "Name is required" },
                { status: 400 }
            );
        }

        const student = await StudentService.createStudent(user.id, branchId, {
            name: body.name,
            phone: body.phone,
        });

        return NextResponse.json(student, { status: 201 });
    } catch (error: any) {
        if (error.message.includes("Unauthorized")) {
            return NextResponse.json({ error: error.message }, { status: 403 });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function GET(
    req: NextRequest,
    { params }: { params: { branchId: string } }
) {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { branchId } = params;
        const students = await StudentService.getStudentsByBranch(user.id, branchId);

        return NextResponse.json(students);
    } catch (error: any) {
        if (error.message.includes("Unauthorized")) {
            return NextResponse.json({ error: error.message }, { status: 403 });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
