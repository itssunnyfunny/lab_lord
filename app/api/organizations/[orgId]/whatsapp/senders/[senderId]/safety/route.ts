import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { whatsAppErrorResponse } from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppSenderSafetyService } from "@/services/whatsappSenderSafety.service";

export async function GET(
  request: Request,
  context: { params: Promise<{ orgId: string; senderId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId, senderId } = await context.params;
    const limited = whatsAppRateLimitResponse(
      request,
      "sender:safety",
      `${user.id}:${orgId}:${senderId}`,
      { limit: 30, windowMs: 60_000 }
    );
    if (limited) return limited;
    return NextResponse.json(await WhatsAppSenderSafetyService.getForOwner({
      actorUserId: user.id,
      organizationId: orgId,
      senderId,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
