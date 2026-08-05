import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BillingService } from "@/services/billing.service";

function errorStatus(message: string) {
  if (message.includes("not found")) return 404;
  if (message.includes("Unauthorized")) return 403;
  if (
    message.includes("must be")
    || message.includes("already ended")
    || message.includes("Only an active")
    || message.includes("mismatch")
  ) return 400;
  return 500;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { orgId } = await context.params;
    const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? `cancel:${orgId}:${Date.now()}`;
    const result = await BillingService.scheduleWorkspaceCancellation(user.id, orgId, idempotencyKey);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId } = await context.params;
    return NextResponse.json(await BillingService.undoWorkspaceCancellation(user.id, orgId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
