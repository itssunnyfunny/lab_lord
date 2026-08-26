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
import {
  WhatsAppReportService,
  type WhatsAppReportScopeInput,
} from "@/services/whatsappReport.service";

const createSubscriptionSchema = z.object({
  phone: z.string().trim().min(8).max(32),
  language: z.enum(["en_IN", "hi"]),
  sendTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
}).strict();

const emptyBodySchema = z.object({}).strict();

const revokeSchema = z.object({
  subscriptionId: z.string().min(1).max(128).optional(),
}).strict();

const organizationSettingsSchema = z.object({
  senderId: z.string().min(1).max(128).nullable().optional(),
  enabled: z.boolean().optional(),
  monthlyBudgetMinor: z.number().int().positive().max(10_000_000).nullable().optional(),
}).strict();

function routeScopeKey(scope: WhatsAppReportScopeInput) {
  return scope.scope === "BRANCH" ? scope.branchId : scope.organizationId;
}

async function actorForReportRequest(
  request: Request,
  scope: WhatsAppReportScopeInput,
  operation: string,
  mutation: boolean
) {
  const user = await getSessionUser();
  if (!user) {
    return {
      kind: "response" as const,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (mutation) assertWhatsAppSameOriginRequest(request);
  const limited = whatsAppRateLimitResponse(
    request,
    `reports:${operation}`,
    `${user.id}:${routeScopeKey(scope)}`
  );
  return limited
    ? { kind: "response" as const, response: limited }
    : { kind: "user" as const, user };
}

export async function handleWhatsAppReportSubscriptionGet(
  request: Request,
  scope: WhatsAppReportScopeInput
) {
  try {
    const actor = await actorForReportRequest(request, scope, "subscription:get", false);
    if (actor.kind === "response") return actor.response;
    return NextResponse.json(await WhatsAppReportService.getSubscription({
      ...scope,
      actorUserId: actor.user.id,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function handleWhatsAppReportSubscriptionCreate(
  request: Request,
  scope: WhatsAppReportScopeInput
) {
  try {
    const actor = await actorForReportRequest(request, scope, "subscription:create", true);
    if (actor.kind === "response") return actor.response;
    const body = await parseWhatsAppJson(request, createSubscriptionSchema);
    return NextResponse.json(await WhatsAppReportService.createSubscription({
      ...scope,
      actorUserId: actor.user.id,
      ...body,
    }), { status: 201 });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function handleWhatsAppReportSubscriptionReissue(
  request: Request,
  scope: WhatsAppReportScopeInput
) {
  try {
    const actor = await actorForReportRequest(request, scope, "subscription:reissue", true);
    if (actor.kind === "response") return actor.response;
    await parseWhatsAppJson(request, emptyBodySchema);
    return NextResponse.json(await WhatsAppReportService.reissueConfirmation({
      ...scope,
      actorUserId: actor.user.id,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function handleWhatsAppReportSubscriptionPause(
  request: Request,
  scope: WhatsAppReportScopeInput
) {
  try {
    const actor = await actorForReportRequest(request, scope, "subscription:pause", true);
    if (actor.kind === "response") return actor.response;
    await parseWhatsAppJson(request, emptyBodySchema);
    return NextResponse.json(await WhatsAppReportService.pauseSubscription({
      ...scope,
      actorUserId: actor.user.id,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function handleWhatsAppReportSubscriptionRevoke(
  request: Request,
  scope: WhatsAppReportScopeInput
) {
  try {
    const actor = await actorForReportRequest(request, scope, "subscription:revoke", true);
    if (actor.kind === "response") return actor.response;
    const body = await parseWhatsAppJson(request, revokeSchema);
    return NextResponse.json(await WhatsAppReportService.revokeSubscription({
      ...scope,
      actorUserId: actor.user.id,
      subscriptionId: body.subscriptionId,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function handleWhatsAppReportPreview(
  request: Request,
  scope: WhatsAppReportScopeInput
) {
  try {
    const actor = await actorForReportRequest(request, scope, "preview", true);
    if (actor.kind === "response") return actor.response;
    await parseWhatsAppJson(request, emptyBodySchema);
    return NextResponse.json(await WhatsAppReportService.preview({
      ...scope,
      actorUserId: actor.user.id,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function handleWhatsAppReportQueueToday(
  request: Request,
  scope: WhatsAppReportScopeInput
) {
  try {
    const actor = await actorForReportRequest(request, scope, "queue-today", true);
    if (actor.kind === "response") return actor.response;
    await parseWhatsAppJson(request, emptyBodySchema);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw new WhatsAppValidationError("Idempotency-Key is required");
    return NextResponse.json(await WhatsAppReportService.queueToday({
      ...scope,
      actorUserId: actor.user.id,
      idempotencyKey,
    }), { status: 202 });
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function handleWhatsAppOrganizationReportSettingsGet(
  request: Request,
  organizationId: string
) {
  const scope = { scope: "ORGANIZATION" as const, organizationId };
  try {
    const actor = await actorForReportRequest(request, scope, "settings:get", false);
    if (actor.kind === "response") return actor.response;
    return NextResponse.json(await WhatsAppReportService.getOrganizationSettings({
      actorUserId: actor.user.id,
      organizationId,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}

export async function handleWhatsAppOrganizationReportSettingsPatch(
  request: Request,
  organizationId: string
) {
  const scope = { scope: "ORGANIZATION" as const, organizationId };
  try {
    const actor = await actorForReportRequest(request, scope, "settings:update", true);
    if (actor.kind === "response") return actor.response;
    const changes = await parseWhatsAppJson(request, organizationSettingsSchema);
    return NextResponse.json(await WhatsAppReportService.updateOrganizationSettings({
      actorUserId: actor.user.id,
      organizationId,
      changes,
    }));
  } catch (error) {
    return whatsAppErrorResponse(error);
  }
}
