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

const cancellationSchema = z.object({ confirmation: z.literal(true) }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ branchId: string; noticeId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { branchId, noticeId } = await context.params;
    const limited = whatsAppRateLimitResponse(
      request,
      "service-notices:cancel",
      `${user.id}:${branchId}:${noticeId}`,
      { limit: 10, windowMs: 10 * 60_000 }
    );
    if (limited) return limited;
    await parseWhatsAppJson(request, cancellationSchema, 256);
    return NextResponse.json(await WhatsAppServiceNoticeService.cancel({
      actorUserId: user.id,
      branchId,
      noticeId,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
