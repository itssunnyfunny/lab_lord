import {
  Prisma,
  type WhatsAppOperationalIncidentSeverity,
  type WhatsAppOperationalIncidentType,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { WhatsAppResourceNotFoundError, WhatsAppValidationError } from "@/lib/whatsappHttp";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import { WhatsAppAuthorizationService } from "@/services/whatsappAuthorization.service";

type PrismaClient = Prisma.TransactionClient | typeof prisma;

const SAFE_TOKEN = /^[A-Z0-9][A-Z0-9._:-]{0,127}$/;
const SAFE_RATE_CARD_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_DETAIL_KEY = /^[a-z][A-Za-z0-9]{0,47}$/;

function boundedId(value: string | null | undefined) {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}

function assertSafeToken(value: string) {
  if (!SAFE_TOKEN.test(value)) throw new WhatsAppValidationError();
}

export function sanitizeWhatsAppIncidentDetails(
  details: Readonly<Record<string, unknown>> | null | undefined
): Prisma.InputJsonObject | undefined {
  if (!details) return undefined;
  const entries = Object.entries(details);
  if (entries.length > 12) throw new WhatsAppValidationError();
  const safe: Record<string, Prisma.InputJsonValue> = {};
  for (const [key, value] of entries) {
    if (!SAFE_DETAIL_KEY.test(key)) throw new WhatsAppValidationError();
    if (typeof value === "boolean") {
      safe[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      safe[key] = value;
      continue;
    }
    if (
      typeof value === "string"
      && (SAFE_TOKEN.test(value)
        || key === "rateCardVersion" && SAFE_RATE_CARD_VERSION.test(value))
    ) {
      safe[key] = value;
      continue;
    }
    throw new WhatsAppValidationError();
  }
  return safe as Prisma.InputJsonObject;
}

async function assertIncidentScope(input: {
  organizationId: string;
  branchId?: string | null;
  senderId?: string | null;
  messageId?: string | null;
  client: PrismaClient;
}) {
  if (
    !boundedId(input.organizationId)
    || input.branchId !== undefined && input.branchId !== null && !boundedId(input.branchId)
    || input.senderId !== undefined && input.senderId !== null && !boundedId(input.senderId)
    || input.messageId !== undefined && input.messageId !== null && !boundedId(input.messageId)
  ) throw new WhatsAppValidationError();

  const [organization, branch, sender, message] = await Promise.all([
    input.client.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    }),
    input.branchId
      ? input.client.branch.findFirst({
          where: { id: input.branchId, organizationId: input.organizationId },
          select: { id: true },
        })
      : Promise.resolve(null),
    input.senderId
      ? input.client.whatsAppSender.findFirst({
          where: { id: input.senderId, organizationId: input.organizationId },
          select: { id: true },
        })
      : Promise.resolve(null),
    input.messageId
      ? input.client.whatsAppMessage.findFirst({
          where: {
            id: input.messageId,
            organizationId: input.organizationId,
            ...(input.branchId ? { branchId: input.branchId } : {}),
            ...(input.senderId ? { senderId: input.senderId } : {}),
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  if (
    !organization
    || input.branchId && !branch
    || input.senderId && !sender
    || input.messageId && !message
  ) throw new WhatsAppResourceNotFoundError();
}

function maskPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `••••••${digits.slice(-4)}` : "••••";
}

export class WhatsAppIncidentService {
  static async createOrTouchInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    branchId?: string | null;
    senderId?: string | null;
    messageId?: string | null;
    type: WhatsAppOperationalIncidentType;
    severity: WhatsAppOperationalIncidentSeverity;
    dedupeKey: string;
    safeCode: string;
    details?: Readonly<Record<string, unknown>> | null;
    now?: Date;
  }) {
    assertSafeToken(input.safeCode);
    if (
      typeof input.dedupeKey !== "string"
      || input.dedupeKey.length < 1
      || input.dedupeKey.length > 180
      || !/^[A-Za-z0-9._:-]+$/.test(input.dedupeKey)
    ) throw new WhatsAppValidationError();
    // Serialize identical incident creation attempts before checking identity.
    // This keeps deduplication race-safe without allowing a colliding key to
    // overwrite another tenant's incident evidence.
    await input.tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${input.dedupeKey}, 0))
    `);
    await assertIncidentScope({ ...input, client: input.tx });
    const details = sanitizeWhatsAppIncidentDetails(input.details);
    const now = input.now ?? new Date();
    const existing = await input.tx.whatsAppOperationalIncident.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });
    if (existing) {
      if (
        existing.organizationId !== input.organizationId
        || existing.branchId !== (input.branchId ?? null)
        || existing.senderId !== (input.senderId ?? null)
        || existing.messageId !== (input.messageId ?? null)
        || existing.type !== input.type
      ) throw new WhatsAppValidationError();
      return input.tx.whatsAppOperationalIncident.update({
        where: { id: existing.id },
        data: {
          severity: input.severity,
          safeCode: input.safeCode,
          lastSeenAt: now,
          occurrenceCount: { increment: 1 },
          details,
          ...(existing.status === "RESOLVED"
            ? { status: "OPEN", resolvedAt: null, resolutionCode: null }
            : {}),
        },
      });
    }
    return input.tx.whatsAppOperationalIncident.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.branchId ?? null,
        senderId: input.senderId ?? null,
        messageId: input.messageId ?? null,
        type: input.type,
        severity: input.severity,
        dedupeKey: input.dedupeKey,
        safeCode: input.safeCode,
        firstSeenAt: now,
        lastSeenAt: now,
        details,
      },
    });
  }

  static async resolveInTransaction(input: {
    tx: Prisma.TransactionClient;
    dedupeKey: string;
    resolutionCode: string;
    now?: Date;
  }) {
    assertSafeToken(input.resolutionCode);
    const now = input.now ?? new Date();
    return input.tx.whatsAppOperationalIncident.updateMany({
      where: { dedupeKey: input.dedupeKey, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now, resolutionCode: input.resolutionCode },
    });
  }

  static async listOrganization(input: {
    actorUserId: string;
    organizationId: string;
    limit?: number;
  }) {
    await WhatsAppAuthorizationService.assertOwnerEntitled(
      input.actorUserId,
      input.organizationId
    );
    return this.listSafe({ organizationId: input.organizationId, limit: input.limit });
  }

  static async listBranch(input: {
    actorUserId: string;
    branchId: string;
    limit?: number;
  }) {
    try {
      await StaffService.authorize(input.actorUserId, input.branchId, "view_whatsapp");
    } catch {
      throw new WhatsAppResourceNotFoundError();
    }
    await EntitlementService.assertBranchEntitlement(input.branchId, "WHATSAPP_AUTOMATION");
    return this.listSafe({ branchId: input.branchId, limit: input.limit });
  }

  private static async listSafe(input: {
    organizationId?: string;
    branchId?: string;
    limit?: number;
  }) {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new WhatsAppValidationError();
    }
    const incidents = await prisma.whatsAppOperationalIncident.findMany({
      where: {
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
      orderBy: [{ status: "asc" }, { severity: "desc" }, { lastSeenAt: "desc" }],
      take: limit,
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        senderId: true,
        messageId: true,
        type: true,
        severity: true,
        status: true,
        safeCode: true,
        firstSeenAt: true,
        lastSeenAt: true,
        occurrenceCount: true,
        acknowledgedAt: true,
        resolvedAt: true,
        resolutionCode: true,
      },
    });
    const unknownMessages = await prisma.whatsAppMessage.findMany({
      where: {
        status: "UNKNOWN",
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
      orderBy: [{ submissionStartedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        senderId: true,
        purpose: true,
        scheduledFor: true,
        submissionStartedAt: true,
        recipientPhoneE164: true,
        estimatedCostMicros: true,
        reportSubscriptionId: true,
        dailyReportSnapshotId: true,
        serviceNoticeId: true,
        paymentResolutionEventId: true,
        providerStatusTimestamp: true,
      },
    });
    return {
      incidents,
      unknownMessages: unknownMessages.map(message => ({
        ...message,
        recipientPhoneE164: undefined,
        maskedRecipient: maskPhone(message.recipientPhoneE164),
        estimatedCostMicros: message.estimatedCostMicros?.toString() ?? null,
        laterWebhookArrived: message.providerStatusTimestamp !== null,
      })),
    };
  }

  static async acknowledge(input: {
    actorUserId: string;
    incidentId: string;
    organizationId?: string;
    branchId?: string;
  }) {
    if (!boundedId(input.incidentId) || Boolean(input.organizationId) === Boolean(input.branchId)) {
      throw new WhatsAppValidationError();
    }
    if (input.organizationId) {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(
        input.actorUserId,
        input.organizationId
      );
    } else {
      try {
        await StaffService.authorize(input.actorUserId, input.branchId!, "manage_whatsapp");
      } catch {
        throw new WhatsAppResourceNotFoundError();
      }
      await EntitlementService.assertBranchWritable(input.branchId!);
    }
    return prisma.$transaction(async tx => {
      if (input.organizationId) {
        await WhatsAppAuthorizationService.assertOwnerCanWrite(
          input.actorUserId,
          input.organizationId,
          tx
        );
      } else {
        try {
          await StaffService.authorize(input.actorUserId, input.branchId!, "manage_whatsapp", tx);
        } catch {
          throw new WhatsAppResourceNotFoundError();
        }
        await EntitlementService.assertBranchWritable(input.branchId!, tx);
      }
      const incident = await tx.whatsAppOperationalIncident.findFirst({
        where: {
          id: input.incidentId,
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
          ...(input.branchId ? { branchId: input.branchId } : {}),
          status: { not: "RESOLVED" },
        },
      });
      if (!incident) throw new WhatsAppResourceNotFoundError();
      const now = new Date();
      const acknowledged = incident.status === "ACKNOWLEDGED"
        ? incident
        : await tx.whatsAppOperationalIncident.update({
            where: { id: incident.id },
            data: {
              status: "ACKNOWLEDGED",
              acknowledgedAt: now,
              acknowledgedByUserId: input.actorUserId,
            },
          });
      if (incident.status !== "ACKNOWLEDGED") {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: incident.organizationId,
            branchId: incident.branchId,
            senderId: incident.senderId,
            actorUserId: input.actorUserId,
            action: "INCIDENT_ACKNOWLEDGED",
            details: { incidentType: incident.type, severity: incident.severity },
          },
        });
      }
      return acknowledged;
    });
  }
}
