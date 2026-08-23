import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isWhatsAppIntegrationEnabled } from "@/lib/whatsappFeature";
import { whatsAppErrorResponse } from "@/lib/whatsappHttp";
import { WhatsAppAuthorizationService } from "@/services/whatsappAuthorization.service";
import { WhatsAppSenderService } from "@/services/whatsappSender.service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId } = await context.params;
    await WhatsAppAuthorizationService.assertOwner(user.id, orgId);
    if (!isWhatsAppIntegrationEnabled()) {
      return NextResponse.json({ enabled: false, canManage: false, safeReason: null, senders: [] });
    }
    return NextResponse.json(await WhatsAppSenderService.listForOwner(user.id, orgId));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
