import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { OwnerTrialService } from "@/services/ownerTrial.service";
import { billingHttpStatus } from "@/lib/billingHttp";

export async function POST(_request: Request, context: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId } = await context.params;
    return NextResponse.json(await OwnerTrialService.claimMigratedTrial(user.id, orgId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to claim trial";
    return NextResponse.json({ error: message }, { status: billingHttpStatus(error) });
  }
}
