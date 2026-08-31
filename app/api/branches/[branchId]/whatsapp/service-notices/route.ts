import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppServiceNoticeService } from "@/services/whatsappServiceNotice.service";

const queueSchema = z.object({
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
  confirmCustomerCharge: z.literal(true),
}).strict();

const listQuerySchema = z.object({
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).transform(Number).optional(),
}).strict();

function parseListQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) {
    throw new WhatsAppValidationError();
  }
  const parsed = listQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new WhatsAppValidationError();
  return parsed.data;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const query = parseListQuery(request);
    return NextResponse.json(await WhatsAppServiceNoticeService.list({
      actorUserId: user.id,
      branchId,
      limit: query.limit,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

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
      "service-notices:queue",
      `${user.id}:${branchId}`,
      { limit: 5, windowMs: 10 * 60_000 }
    );
    if (limited) return limited;
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw new WhatsAppValidationError("Idempotency-Key is required");
    const body = await parseWhatsAppJson(request, queueSchema, 4_096);
    const { confirmCustomerCharge, ...draft } = body;
    return NextResponse.json(await WhatsAppServiceNoticeService.queue({
      actorUserId: user.id,
      branchId,
      draft,
      idempotencyKey,
      confirmCustomerCharge,
    }), { status: 202 });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
