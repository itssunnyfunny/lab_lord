import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  whatsAppErrorResponse,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppRecipientService } from "@/services/whatsappRecipient.service";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ branchId: string; recipientId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { branchId, recipientId } = await context.params;
    if (!branchId || branchId.length > 128 || !recipientId || recipientId.length > 128) {
      throw new WhatsAppValidationError();
    }
    const limited = whatsAppRateLimitResponse(
      request,
      "recipients:disable",
      `${user.id}:${branchId}`,
      { limit: 20, windowMs: 60_000 }
    );
    if (limited) return limited;
    return NextResponse.json(
      await WhatsAppRecipientService.disable({
        actorUserId: user.id,
        branchId,
        recipientId,
      })
    );
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
