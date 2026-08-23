import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppRecipientService } from "@/services/whatsappRecipient.service";

const recipientSchema = z.object({
  studentId: z.string().min(1).max(128),
  relationship: z.enum(["SELF", "GUARDIAN", "OTHER"]),
  attestation: z.literal(true),
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
      "recipients:associate",
      `${user.id}:${branchId}`,
      { limit: 20, windowMs: 60_000 }
    );
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, recipientSchema, 2_048);
    const result = await WhatsAppRecipientService.associate({
      actorUserId: user.id,
      branchId,
      studentId: body.studentId,
      relationship: body.relationship,
      attestation: body.attestation,
    });
    return NextResponse.json(result);
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
