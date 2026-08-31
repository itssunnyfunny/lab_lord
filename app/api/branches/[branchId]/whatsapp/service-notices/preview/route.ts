import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppServiceNoticeService } from "@/services/whatsappServiceNotice.service";

const draftSchema = z.object({
  type: z.enum(["BRANCH_CLOSED", "HOURS_CHANGED", "MAINTENANCE_WINDOW"]),
  reason: z.enum(["PUBLIC_HOLIDAY", "LOCAL_HOLIDAY", "MAINTENANCE", "EMERGENCY", "ADMINISTRATIVE"]),
  localEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  resumeLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  openingTimeLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  closingTimeLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  maintenanceStartTimeLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  maintenanceEndTimeLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  delivery: z.enum(["IMMEDIATE", "SCHEDULED"]),
  scheduledForLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable(),
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
    const limited = whatsAppRateLimitResponse(
      request,
      "service-notices:preview",
      `${user.id}:${branchId}`,
      { limit: 10, windowMs: 60_000 }
    );
    if (limited) return limited;
    const draft = await parseWhatsAppJson(request, draftSchema, 4_096);
    return NextResponse.json(await WhatsAppServiceNoticeService.preview({
      actorUserId: user.id,
      branchId,
      draft,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
