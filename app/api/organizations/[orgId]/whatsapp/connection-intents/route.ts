import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertWhatsAppSameOriginRequest, whatsAppErrorResponse } from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppConnectionService } from "@/services/whatsappConnection.service";

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { orgId } = await context.params;
    const limited = whatsAppRateLimitResponse(request, "intent:create", `${user.id}:${orgId}`, {
      limit: 5,
      windowMs: 10 * 60_000,
    });
    if (limited) return limited;
    const result = await WhatsAppConnectionService.createIntent(user.id, orgId);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
