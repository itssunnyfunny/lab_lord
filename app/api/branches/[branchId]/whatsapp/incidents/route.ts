import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { whatsAppErrorResponse, WhatsAppValidationError } from "@/lib/whatsappHttp";
import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";

const querySchema = z.object({
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).transform(Number).optional(),
}).strict();

function query(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) {
    throw new WhatsAppValidationError();
  }
  const parsed = querySchema.safeParse(Object.fromEntries(params));
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
    const { limit } = query(request);
    return NextResponse.json(await WhatsAppIncidentService.listBranch({
      actorUserId: user.id,
      branchId,
      limit,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
