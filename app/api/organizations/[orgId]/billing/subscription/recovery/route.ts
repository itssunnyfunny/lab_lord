import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BillingService } from "@/services/billing.service";
import { BillingWritesDisabledError } from "@/lib/billingFeature";
import { RazorpayApiError, RazorpayConfigurationError } from "@/lib/razorpay";

export async function POST(request: Request, context: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId } = await context.params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await BillingService.getRecoveryCheckout(user.id, orgId, body.returnPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start payment recovery";
    const status = error instanceof BillingWritesDisabledError || error instanceof RazorpayConfigurationError
      ? 503
      : error instanceof RazorpayApiError
        ? 502
        : /Unauthorized/.test(message)
          ? 403
          : 400;
    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
