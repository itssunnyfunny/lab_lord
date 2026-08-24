import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { WhatsAppValidationError, whatsAppErrorResponse } from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppRecipientService } from "@/services/whatsappRecipient.service";

export async function GET(
  request: Request,
  context: { params: Promise<{ branchId: string; studentId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId, studentId } = await context.params;
    if (!branchId || branchId.length > 128 || !studentId || studentId.length > 128) {
      throw new WhatsAppValidationError();
    }
    const limited = whatsAppRateLimitResponse(
      request,
      "recipients:student:get",
      `${user.id}:${branchId}`,
      { limit: 60, windowMs: 60_000 }
    );
    if (limited) return limited;
    return NextResponse.json(await WhatsAppRecipientService.getForStudent({
      actorUserId: user.id,
      branchId,
      studentId,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
