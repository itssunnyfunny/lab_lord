import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { assertWhatsAppSameOriginRequest, parseWhatsAppJson, whatsAppErrorResponse } from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppAutomationService } from "@/services/whatsappAutomation.service";

const confirmationSchema = z.object({
  confirmChargesAndProspectiveAutomation: z.literal(true),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { branchId } = await context.params;
    const limited = whatsAppRateLimitResponse(request, "automation:enable", `${user.id}:${branchId}`);
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, confirmationSchema);
    return NextResponse.json(await WhatsAppAutomationService.enableAutomation({
      actorUserId: user.id,
      branchId,
      confirmChargesAndProspectiveAutomation: body.confirmChargesAndProspectiveAutomation,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
