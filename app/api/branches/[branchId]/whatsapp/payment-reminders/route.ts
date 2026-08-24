import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { assertWhatsAppSameOriginRequest, parseWhatsAppJson, whatsAppErrorResponse, WhatsAppValidationError } from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppMessageService } from "@/services/whatsappMessage.service";

const queueSchema = z.object({
  paymentIds: z.array(z.string().min(1).max(128)).min(1).max(100),
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
    const limited = whatsAppRateLimitResponse(request, "payment-reminders:queue", `${user.id}:${branchId}`);
    if (limited) return limited;
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw new WhatsAppValidationError("Idempotency-Key is required");
    const body = await parseWhatsAppJson(request, queueSchema);
    return NextResponse.json(await WhatsAppMessageService.queuePaymentReminders({
      actorUserId: user.id,
      branchId,
      paymentIds: body.paymentIds,
      idempotencyKey,
    }), { status: 202 });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
