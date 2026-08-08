import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BranchService } from "@/services/branch.service";
import { billingHttpStatus } from "@/lib/billingHttp";

type Context = { params: Promise<{ branchId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Idempotency-Key is required" }, { status: 400 });
    }
    const result = await BranchService.scheduleBillingRemoval(user.id, branchId, idempotencyKey);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to schedule branch removal";
    return NextResponse.json({ error: message }, { status: billingHttpStatus(error) });
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    return NextResponse.json(await BranchService.undoBillingRemoval(user.id, branchId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to undo branch removal";
    return NextResponse.json({ error: message }, { status: billingHttpStatus(error) });
  }
}
