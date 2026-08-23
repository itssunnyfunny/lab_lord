import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppConnectionService } from "@/services/whatsappConnection.service";

const completeSchema = z.object({
  state: z.string().min(1).max(256),
  code: z.string().min(1).max(4_096),
  businessId: z.string().regex(/^[0-9]{1,64}$/).nullable().optional(),
  wabaId: z.string().regex(/^[0-9]{1,64}$/),
  phoneNumberId: z.string().regex(/^[0-9]{1,64}$/),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string; intentId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { orgId, intentId } = await context.params;
    const limited = whatsAppRateLimitResponse(
      request,
      "intent:complete",
      `${user.id}:${orgId}`,
      { limit: 10, windowMs: 10 * 60_000 }
    );
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, completeSchema);
    await WhatsAppConnectionService.complete({
      actorUserId: user.id,
      organizationId: orgId,
      intentId,
      ...body,
    });
    return NextResponse.json({ completed: true as const });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
