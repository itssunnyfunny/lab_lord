import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppSenderSafetyService } from "@/services/whatsappSenderSafety.service";

const confirmationSchema = z.object({ confirmation: z.literal(true) }).strict();

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
      "sender:pause",
      `${user.id}:${orgId}:${senderId}`,
      { limit: 5, windowMs: 10 * 60_000 }
    );
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, confirmationSchema, 256);
    const result = await WhatsAppSenderSafetyService.pauseByOwner({
      actorUserId: user.id,
      organizationId: orgId,
      senderId,
      confirmation: body.confirmation,
    });
    return NextResponse.json({
      changed: result.changed,
      paused: Boolean(result.state.pausedAt || result.state.pauseRequestedAt),
      pausePending: Boolean(result.pausePending),
      pauseReason: result.state.pauseReason,
      pauseRequestedAt: result.state.pauseRequestedAt ?? null,
      pauseRevision: result.state.pauseRevision,
    });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
