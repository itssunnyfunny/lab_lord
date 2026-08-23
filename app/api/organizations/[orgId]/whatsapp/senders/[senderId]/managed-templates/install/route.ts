import { NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppTemplateProvisioningService } from "@/services/whatsappTemplateProvisioning.service";

const installSchema = z.object({
  languages: z.array(z.enum(["en_IN", "hi"])).min(1).max(2)
    .refine(languages => new Set(languages).size === languages.length),
  catalogVersion: z.literal(1),
}).strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ orgId: string; senderId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { orgId, senderId } = await context.params;
    const installation = await WhatsAppTemplateProvisioningService.getStatus({
      actorUserId: user.id,
      organizationId: orgId,
      senderId,
    });
    return NextResponse.json(
      { installation },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

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
      "managed-templates:install",
      `${user.id}:${orgId}:${senderId}`,
      { limit: 2, windowMs: 10 * 60_000 }
    );
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, installSchema, 1_024);
    const installation = await WhatsAppTemplateProvisioningService.install({
      actorUserId: user.id,
      organizationId: orgId,
      senderId,
      languages: body.languages,
      catalogVersion: body.catalogVersion,
    });
    return NextResponse.json({ installation });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
