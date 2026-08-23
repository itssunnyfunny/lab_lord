import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppSenderService } from "@/services/whatsappSender.service";

const registrationSchema = z.object({ pin: z.string().regex(/^[0-9]{6}$/) }).strict();

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
      "sender:register",
      `${user.id}:${orgId}`,
      { limit: 5, windowMs: 10 * 60_000 }
    );
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, registrationSchema, 1_024);
    await WhatsAppSenderService.registerPhone({
      actorUserId: user.id,
      organizationId: orgId,
      senderId,
      pin: body.pin,
    });
    return NextResponse.json({ registered: true as const });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
