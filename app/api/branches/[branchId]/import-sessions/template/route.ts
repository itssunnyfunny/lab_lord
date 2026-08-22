import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ImportTemplateService } from "@/importing/services/import-template.service";
import type { ImportGoal } from "@/app/generated/prisma/enums";

type Params = { params: Promise<{ branchId: string }> };

function parseGoal(value: string | null): ImportGoal | null {
  if (value === "STUDENTS" || value === "STUDENTS_ALLOCATIONS" || value === "FULL") {
    return value;
  }
  return null;
}

export async function GET(req: Request, { params }: Params) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { branchId } = await params;
  const url = new URL(req.url);
  const goal = parseGoal(url.searchParams.get("goal"));
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  if (!goal) {
    return NextResponse.json({ error: "A valid import goal is required." }, { status: 400 });
  }

  try {
    const template = await ImportTemplateService.buildTemplate(user.id, branchId, goal, format);
    return new Response(new Uint8Array(template.body), {
      headers: {
        "Content-Type": template.contentType,
        "Content-Disposition": `attachment; filename="${template.fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Import resource not found." }, { status: 404 });
  }
}
