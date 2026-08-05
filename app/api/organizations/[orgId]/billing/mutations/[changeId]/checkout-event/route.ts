import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BillingService } from "@/services/billing.service";

type Context = { params: Promise<{ orgId: string; changeId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId, changeId } = await context.params;
    return NextResponse.json(await BillingService.recordCheckoutEvent(
      user.id,
      orgId,
      changeId,
      await request.json()
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record checkout status";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : /not found/.test(message) ? 404 : 400 });
  }
}
