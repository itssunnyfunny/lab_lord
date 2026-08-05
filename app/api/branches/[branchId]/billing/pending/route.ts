import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BranchService } from "@/services/branch.service";

type Context = { params: Promise<{ branchId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    return NextResponse.json(await BranchService.retryPendingActivation(user.id, branchId), { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to retry branch activation";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : /not found/.test(message) ? 404 : 400 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    return NextResponse.json(await BranchService.discardPendingActivation(user.id, branchId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to discard pending branch";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : /not found/.test(message) ? 404 : 400 });
  }
}
