import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { billingHttpStatus } from "@/lib/billingHttp";
import { BillingChangeInProgressError } from "@/lib/billingErrors";
import { BillingService } from "@/services/billing.service";

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Idempotency-Key is required" }, { status: 400 });
    }
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await BillingService.createPaymentMethodReplacement(
      user.id,
      orgId,
      idempotencyKey,
      body.returnPath
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to change payment method";
    return NextResponse.json(
      error instanceof BillingChangeInProgressError
        ? { error: message, code: error.code, existingChangeId: error.existingChangeId }
        : { error: message },
      { status: billingHttpStatus(error) }
    );
  }
}
