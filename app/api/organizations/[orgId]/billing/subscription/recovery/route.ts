import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BillingService } from "@/services/billing.service";

export async function POST(_request: Request, context: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId } = await context.params;
    return NextResponse.json(await BillingService.getRecoveryCheckout(user.id, orgId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start payment recovery";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : 400 });
  }
}
