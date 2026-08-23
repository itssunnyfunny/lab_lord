import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import {
  WHATSAPP_AUTOMATION_STAGES,
  WHATSAPP_SETTINGS_LANGUAGES,
  WHATSAPP_SETTINGS_TONES,
  WhatsAppAutomationService,
} from "@/services/whatsappAutomation.service";

const updateSchema = z.object({
  defaultLanguage: z.enum(WHATSAPP_SETTINGS_LANGUAGES).optional(),
  defaultTone: z.enum(WHATSAPP_SETTINGS_TONES).optional(),
  sendTimeLocal: z.string().max(5).optional(),
  dailyAutomaticMessageLimit: z.number().int().optional(),
  maxAutomaticCollectionMessagesPerCycle: z.number().int().optional(),
  monthlyBudgetMinor: z.number().int().nullable().optional(),
  rules: z.array(z.object({
    stage: z.enum(WHATSAPP_AUTOMATION_STAGES),
    enabled: z.boolean(),
  })).max(WHATSAPP_AUTOMATION_STAGES.length).optional(),
}).strict();

export async function GET(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const limited = whatsAppRateLimitResponse(request, "settings:get", `${user.id}:${branchId}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (limited) return limited;
    return NextResponse.json(await WhatsAppAutomationService.get({ actorUserId: user.id, branchId }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
export async function PATCH(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { branchId } = await context.params;
    const limited = whatsAppRateLimitResponse(request, "settings:update", `${user.id}:${branchId}`);
    if (limited) return limited;
    const changes = await parseWhatsAppJson(request, updateSchema);
    return NextResponse.json(await WhatsAppAutomationService.update({
      actorUserId: user.id,
      branchId,
      changes,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
