import { NextRequest, NextResponse } from "next/server";
import { StudentService } from "@/services/student.service";
import { getSessionUser } from "@/lib/auth";
import { StudentStatus } from "@prisma/client";

export async function PATCH(
    req: NextRequest,
    { params }: { params: { studentId: string } }
) {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { studentId } = params;
        const body = await req.json();

        if (!body.status || !Object.keys(StudentStatus).includes(body.status)) {
            return NextResponse.json(
                { error: "Valid status is required" },
                { status: 400 }
            );
        }

        const student = await StudentService.updateStudentStatus(
            user.id,
            studentId,
            body.status
        );

        return NextResponse.json(student);
    } catch (error: any) {
        if (error.message.includes("Unauthorized")) {
            return NextResponse.json({ error: error.message }, { status: 403 });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
