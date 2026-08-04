import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BillingService } from "@/services/billing.service";

type Context = { params: Promise<{ orgId: string; changeId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId, changeId } = await context.params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await BillingService.reconcileMutation(
      user.id,
      orgId,
      changeId,
      typeof body.paymentId === "string" ? body.paymentId : undefined
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reconcile billing change";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : 400 });
  }
}

export async function GET(_request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId, changeId } = await context.params;
    return NextResponse.json(await BillingService.getBillingOperation(user.id, orgId, changeId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load billing operation";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : /not found/.test(message) ? 404 : 400 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId, changeId } = await context.params;
    return NextResponse.json(await BillingService.undoWorkspaceChange(user.id, orgId, changeId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to undo billing change";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : 400 });
  }
}
