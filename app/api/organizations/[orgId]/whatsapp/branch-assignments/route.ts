import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { isWhatsAppIntegrationEnabled } from "@/lib/whatsappFeature";
import {
  assertWhatsAppSameOriginRequest,
  parseWhatsAppJson,
  whatsAppErrorResponse,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppSenderService } from "@/services/whatsappSender.service";

const assignmentSchema = z.object({
  branchId: z.string().min(1).max(128),
  senderId: z.string().min(1).max(128),
}).strict();
const unassignmentSchema = z.object({ branchId: z.string().min(1).max(128) }).strict();

export async function GET(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isWhatsAppIntegrationEnabled()) {
      return NextResponse.json({
        enabled: false,
        canManage: false,
        safeReason: null,
        assignment: null,
        availableSenders: [],
      });
    }
    const { orgId } = await context.params;
    const branchId = new URL(request.url).searchParams.get("branchId");
    if (!branchId || branchId.length > 128) throw new WhatsAppValidationError();
    return NextResponse.json(
      await WhatsAppSenderService.getBranchAssignment(user.id, orgId, branchId)
    );
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { orgId } = await context.params;
    const limited = whatsAppRateLimitResponse(request, "branch:assign", `${user.id}:${orgId}`);
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, assignmentSchema, 2_048);
    await WhatsAppSenderService.assignBranch({
      actorUserId: user.id,
      organizationId: orgId,
      ...body,
    });
    return NextResponse.json({ assigned: true as const });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertWhatsAppSameOriginRequest(request);
    const { orgId } = await context.params;
    const limited = whatsAppRateLimitResponse(request, "branch:unassign", `${user.id}:${orgId}`);
    if (limited) return limited;
    const body = await parseWhatsAppJson(request, unassignmentSchema, 1_024);
    await WhatsAppSenderService.unassignBranch({
      actorUserId: user.id,
      organizationId: orgId,
      branchId: body.branchId,
    });
    return NextResponse.json({ unassigned: true as const });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
