import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BillingService } from "@/services/billing.service";
import { billingHttpStatus } from "@/lib/billingHttp";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
} from "@/lib/billingErrors";

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
    return NextResponse.json(
      error instanceof BillingChangeInProgressError
        ? { error: message, code: error.code, existingChangeId: error.existingChangeId }
        : error instanceof BillingManualReviewRequiredError
          ? {
              error: message,
              code: error.code,
              changeId: error.changeId,
              resolutionOutcome: error.resolutionOutcome,
            }
          : { error: message },
      { status: billingHttpStatus(error, 500) }
    );
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
      await BillingService.changeWorkspacePlan(user.id, orgId, body.plan, idempotencyKey, body.returnPath),
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json(
      error instanceof BillingChangeInProgressError
        ? { error: message, code: error.code, existingChangeId: error.existingChangeId }
        : { error: message },
      { status: billingHttpStatus(error, 500) }
    );
  }
}
