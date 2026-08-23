import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertWhatsAppSameOriginRequest, whatsAppErrorResponse } from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppSenderService } from "@/services/whatsappSender.service";

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string; senderId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { orgId, senderId } = await context.params;
    const limited = whatsAppRateLimitResponse(
      request,
      "sender:disconnect",
      `${user.id}:${orgId}:${senderId}`,
      { limit: 5, windowMs: 10 * 60_000 }
    );
    if (limited) return limited;
    await WhatsAppSenderService.disconnectLocal({
      actorUserId: user.id,
      organizationId: orgId,
      senderId,
    });
    return NextResponse.json({ disconnected: true as const });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
