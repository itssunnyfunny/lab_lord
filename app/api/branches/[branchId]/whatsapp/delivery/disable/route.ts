import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertWhatsAppSameOriginRequest, whatsAppErrorResponse } from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppAutomationService } from "@/services/whatsappAutomation.service";

export async function POST(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { branchId } = await context.params;
    const limited = whatsAppRateLimitResponse(request, "delivery:disable", `${user.id}:${branchId}`);
    if (limited) return limited;
    return NextResponse.json(await WhatsAppAutomationService.disableDelivery({
      actorUserId: user.id,
      branchId,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
