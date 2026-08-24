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
  MAX_WHATSAPP_RECIPIENT_BULK_SIZE,
  WhatsAppRecipientService,
} from "@/services/whatsappRecipient.service";

const recipientSelectionSchema = z.object({
  studentId: z.string().min(1).max(128),
  relationship: z.enum(["SELF", "GUARDIAN", "OTHER"]),
}).strict();

const bulkRecipientSchema = z.object({
  recipients: z.array(recipientSelectionSchema)
    .min(1)
    .max(MAX_WHATSAPP_RECIPIENT_BULK_SIZE),
  attestation: z.literal(true),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.recipients.forEach((recipient, index) => {
    if (ids.has(recipient.studentId)) {
      context.addIssue({
        code: "custom",
        message: "Duplicate student",
        path: ["recipients", index, "studentId"],
      });
    }
    ids.add(recipient.studentId);
  });
});

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
      "recipients:bulk",
      `${user.id}:${branchId}`,
      { limit: 5, windowMs: 10 * 60_000 }
    );
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, bulkRecipientSchema, 32 * 1024);
    const result = await WhatsAppRecipientService.associateBulk({
      actorUserId: user.id,
      branchId,
      recipients: body.recipients,
      attestation: body.attestation,
    });
    return NextResponse.json(result);
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
