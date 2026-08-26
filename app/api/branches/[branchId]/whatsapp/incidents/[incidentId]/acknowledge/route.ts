import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";

const acknowledgeSchema = z.object({ confirmation: z.literal(true) }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ branchId: string; incidentId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { branchId, incidentId } = await context.params;
    const limited = whatsAppRateLimitResponse(
      request,
      "incidents:acknowledge",
      `${user.id}:${branchId}:${incidentId}`,
      { limit: 20, windowMs: 60_000 }
    );
    if (limited) return limited;
    await parseWhatsAppJson(request, acknowledgeSchema, 256);
    return NextResponse.json(await WhatsAppIncidentService.acknowledge({
      actorUserId: user.id,
      branchId,
      incidentId,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
