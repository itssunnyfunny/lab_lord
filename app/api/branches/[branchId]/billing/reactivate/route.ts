import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BranchService } from "@/services/branch.service";

type Context = { params: Promise<{ branchId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || `branch-reactivation:${branchId}:${crypto.randomUUID()}`;
    return NextResponse.json(await BranchService.reactivateArchivedBranch(user.id, branchId, idempotencyKey), { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reactivate branch";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : /not found/.test(message) ? 404 : 400 });
  }
}
