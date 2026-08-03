import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BillingService } from "@/services/billing.service";

function errorStatus(message: string) {
  if (message.includes("not found")) return 404;
  if (message.includes("Unauthorized")) return 403;
  if (
    message.includes("Unknown") ||
    message.includes("not available") ||
    message.includes("already has") ||
    message.includes("Cancel or complete") ||
    message.includes("must be")
  ) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { orgId } = await context.params;
    const checkout = await BillingService.createSubscriptionCheckout(user.id, orgId, await req.json());

    return NextResponse.json(checkout);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId } = await context.params;
    const idempotencyKey = req.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) return NextResponse.json({ error: "Idempotency-Key is required" }, { status: 400 });
    const body = await req.json();
    return NextResponse.json(
      await BillingService.changeWorkspacePlan(user.id, orgId, body.plan, idempotencyKey),
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
