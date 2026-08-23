import type {
  Prisma,
  WhatsAppConsentSource,
  WhatsAppConsentStatus,
  WhatsAppConsentType,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { assertWhatsAppIntegrationEnabled } from "@/lib/whatsappFeature";
import { normalizeWhatsAppPhone } from "@/lib/whatsappPhone";
import { WhatsAppResourceNotFoundError } from "@/lib/whatsappHttp";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";

const MAX_CONSENT_DETAILS_BYTES = 4_096;

function safeDetails(details: Prisma.InputJsonValue | undefined) {
  if (details === undefined) return undefined;
  return Buffer.byteLength(JSON.stringify(details), "utf8") <= MAX_CONSENT_DETAILS_BYTES
    ? details
    : undefined;
}

export class WhatsAppConsentService {
  static async record(input: {
    actorUserId: string;
    branchId: string;
    senderId: string;
    phone: string;
    consentType: WhatsAppConsentType;
    nextStatus: WhatsAppConsentStatus;
    source: WhatsAppConsentSource;
    details?: Prisma.InputJsonValue;
  }) {
    await StaffService.authorize(input.actorUserId, input.branchId, "manage_whatsapp");
    assertWhatsAppIntegrationEnabled();
    await EntitlementService.assertBranchEntitlement(
      input.branchId,
      "WHATSAPP_AUTOMATION"
    );
    await EntitlementService.assertBranchWritable(input.branchId);
    const phoneE164 = normalizeWhatsAppPhone(input.phone, { defaultCountry: "IN" });

    return prisma.$transaction(async tx => {
      await StaffService.authorize(
        input.actorUserId,
        input.branchId,
        "manage_whatsapp",
        tx
      );
      assertWhatsAppIntegrationEnabled();
      await EntitlementService.assertBranchEntitlement(
        input.branchId,
        "WHATSAPP_AUTOMATION",
        tx
      );
      await EntitlementService.assertBranchWritable(input.branchId, tx);

      const branch = await tx.branch.findUnique({
        where: { id: input.branchId },
        select: { organizationId: true },
      });
      const sender = branch
        ? await tx.whatsAppSender.findFirst({
            where: {
              id: input.senderId,
              organizationId: branch.organizationId,
              status: { not: "DISCONNECTED" },
            },
            select: { id: true },
          })
        : null;
      if (!branch || !sender) throw new WhatsAppResourceNotFoundError();

      const existing = await tx.whatsAppConsent.findUnique({
        where: {
          senderId_phoneE164_consentType: {
            senderId: sender.id,
            phoneE164,
            consentType: input.consentType,
          },
        },
      });
      const previousStatus = existing?.status ?? "UNKNOWN";
      if (previousStatus === input.nextStatus) return { consent: existing, changed: false };

      const now = new Date();
      const consent = existing
        ? await tx.whatsAppConsent.update({
            where: { id: existing.id },
            data: {
              status: input.nextStatus,
              source: input.source,
              recordedByUserId: input.actorUserId,
              grantedAt: input.nextStatus === "OPTED_IN" ? now : existing.grantedAt,
              revokedAt: input.nextStatus === "OPTED_OUT" ? now : null,
            },
          })
        : await tx.whatsAppConsent.create({
            data: {
              senderId: sender.id,
              phoneE164,
              consentType: input.consentType,
              status: input.nextStatus,
              source: input.source,
              recordedByUserId: input.actorUserId,
              grantedAt: input.nextStatus === "OPTED_IN" ? now : null,
              revokedAt: input.nextStatus === "OPTED_OUT" ? now : null,
            },
          });

      await tx.whatsAppConsentEvent.create({
        data: {
          consentId: consent.id,
          senderId: sender.id,
          phoneE164,
          consentType: input.consentType,
          actorUserId: input.actorUserId,
          previousStatus,
          nextStatus: input.nextStatus,
          source: input.source,
          details: safeDetails(input.details),
        },
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: branch.organizationId,
          branchId: input.branchId,
          senderId: sender.id,
          actorUserId: input.actorUserId,
          action: "CONSENT_CHANGED",
          details: { consentType: input.consentType, nextStatus: input.nextStatus },
        },
      });

      return { consent, changed: true };
    });
  }
}
