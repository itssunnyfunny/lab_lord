import type {
  Prisma,
  WhatsAppAutomationStage,
  WhatsAppMessagePurpose,
  WhatsAppMessageTrigger,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertWhatsAppDeliverySchemaAccessEnabled,
  assertWhatsAppIntegrationEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { normalizeWhatsAppPhone } from "@/lib/whatsappPhone";
import {
  MAX_WHATSAPP_RECIPIENT_BULK_SIZE,
  WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
  WHATSAPP_OPERATIONAL_CONSENT_STATEMENT,
} from "@/lib/whatsappConsentPolicy";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import { WhatsAppConsentService } from "@/services/whatsappConsent.service";

export {
  MAX_WHATSAPP_RECIPIENT_BULK_SIZE,
  WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
  WHATSAPP_OPERATIONAL_CONSENT_STATEMENT,
};

const RECIPIENT_RELATIONSHIPS = new Set(["SELF", "GUARDIAN", "OTHER"] as const);

export type WhatsAppRecipientRelationship = "SELF" | "GUARDIAN" | "OTHER";

export type WhatsAppRecipientSelection = {
  studentId: string;
  relationship: WhatsAppRecipientRelationship;
};

type RecipientMutationInput = {
  actorUserId: string;
  branchId: string;
  attestation: boolean;
};

type RecipientScope = {
  organizationId: string;
  branchId: string;
  senderId: string;
};

type RecipientStudent = {
  id: string;
  branchId: string;
  phone: string | null;
  status: "ACTIVE" | "INACTIVE";
};

export type WhatsAppUnsubmittedMessageDisposition = "CANCELLED" | "SUPPRESSED";

export type WhatsAppUnsubmittedMessageScope = {
  organizationId?: string;
  branchId?: string;
  senderId?: string;
  recipientPhoneE164?: string;
  excludeRecipientPhoneE164?: string;
  studentId?: string;
  paymentId?: string;
  reportSubscriptionId?: string;
  serviceNoticeId?: string;
  purpose?: WhatsAppMessagePurpose;
  trigger?: WhatsAppMessageTrigger;
  automationStage?: WhatsAppAutomationStage;
};

function assertRelationship(
  relationship: string
): asserts relationship is WhatsAppRecipientRelationship {
  if (!RECIPIENT_RELATIONSHIPS.has(relationship as WhatsAppRecipientRelationship)) {
    throw new WhatsAppValidationError();
  }
}

function assertAttestation(attestation: boolean) {
  if (attestation !== true) throw new WhatsAppValidationError();
}

function assertBoundedId(value: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new WhatsAppValidationError();
  }
}

function isGenericAuthorizationFailure(error: unknown) {
  return error instanceof Error
    && (error.message === "Branch not found" || error.message.startsWith("Unauthorized:"));
}

async function authorizeRecipientMutation(
  actorUserId: string,
  branchId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  try {
    await StaffService.authorize(actorUserId, branchId, "manage_whatsapp", client);
  } catch (error) {
    if (isGenericAuthorizationFailure(error)) throw new WhatsAppResourceNotFoundError();
    throw error;
  }
  assertWhatsAppIntegrationEnabled();
  await EntitlementService.assertBranchEntitlement(
    branchId,
    "WHATSAPP_AUTOMATION",
    client
  );
  await EntitlementService.assertBranchWritable(branchId, client);
}

async function authorizeRecipientView(
  actorUserId: string,
  branchId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  try {
    await StaffService.authorize(actorUserId, branchId, "view_whatsapp", client);
  } catch (error) {
    if (isGenericAuthorizationFailure(error)) throw new WhatsAppResourceNotFoundError();
    throw error;
  }
  assertWhatsAppIntegrationEnabled();
  await EntitlementService.assertBranchEntitlement(
    branchId,
    "WHATSAPP_AUTOMATION",
    client
  );
}

function maskRecipientPhone(value: string | null) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `••••••${digits.slice(-4)}`;
}

function safeConsentPolicyVersion(value: string | null) {
  return value && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : null;
}

function safeIsoDate(value: Date | null) {
  return value ? value.toISOString() : null;
}

function matchesCurrentStudentPhone(studentPhone: string | null, recipientPhone: string) {
  if (!studentPhone) return false;
  try {
    return normalizeWhatsAppPhone(studentPhone, { defaultCountry: "IN" }) === recipientPhone;
  } catch {
    return false;
  }
}

async function resolveCurrentRecipientScope(
  tx: Prisma.TransactionClient,
  branchId: string
): Promise<RecipientScope> {
  const providerMode = resolveWhatsAppProviderMode();
  const branch = await tx.branch.findUnique({
    where: { id: branchId },
    select: { id: true, organizationId: true },
  });
  const lockedSettings = branch
    ? await tx.$queryRaw<Array<{ senderId: string | null }>>`
        SELECT "senderId"
        FROM "BranchWhatsAppSettings"
        WHERE "branchId" = ${branch.id}
          AND "organizationId" = ${branch.organizationId}
        FOR UPDATE
      `
    : [];
  const settings = branch && lockedSettings.length === 1
    ? await tx.branchWhatsAppSettings.findFirst({
        where: {
          branchId: branch.id,
          organizationId: branch.organizationId,
          senderId: { not: null },
        },
        select: { senderId: true },
      })
    : null;
  const sender = branch && settings?.senderId
    ? await tx.whatsAppSender.findFirst({
        where: {
          id: settings.senderId,
          organizationId: branch.organizationId,
          provider: "META_CLOUD",
          providerMode,
          status: "ACTIVE",
        },
        select: { id: true },
      })
    : null;
  if (!branch || !sender) throw new WhatsAppResourceNotFoundError();

  return {
    organizationId: branch.organizationId,
    branchId: branch.id,
    senderId: sender.id,
  };
}

function assertCancellationReason(reason: string) {
  if (!/^[A-Z0-9_]{1,64}$/.test(reason)) throw new WhatsAppValidationError();
}

function assertCancellationScope(scope: WhatsAppUnsubmittedMessageScope) {
  // This primitive is intentionally fail-closed: every cancellation must carry
  // an explicit tenant boundary even when a narrower object filter is present.
  if (!scope.organizationId && !scope.branchId) {
    throw new WhatsAppValidationError();
  }
  if (scope.organizationId) assertBoundedId(scope.organizationId);
  if (scope.branchId) assertBoundedId(scope.branchId);
  if (scope.senderId) assertBoundedId(scope.senderId);
  if (scope.studentId) assertBoundedId(scope.studentId);
  if (scope.paymentId) assertBoundedId(scope.paymentId);
  if (scope.reportSubscriptionId) assertBoundedId(scope.reportSubscriptionId);
  if (scope.serviceNoticeId) assertBoundedId(scope.serviceNoticeId);
  if (scope.recipientPhoneE164 && scope.excludeRecipientPhoneE164) {
    throw new WhatsAppValidationError();
  }
  for (const phone of [
    scope.recipientPhoneE164,
    scope.excludeRecipientPhoneE164,
  ]) {
    if (phone && normalizeWhatsAppPhone(phone) !== phone) {
      throw new WhatsAppValidationError();
    }
  }
}

function unsubmittedMessageWhere(
  scope: WhatsAppUnsubmittedMessageScope
): Prisma.WhatsAppMessageWhereInput {
  const scopeWhere: Prisma.WhatsAppMessageWhereInput = {
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
    ...(scope.senderId ? { senderId: scope.senderId } : {}),
    ...(scope.recipientPhoneE164
      ? { recipientPhoneE164: scope.recipientPhoneE164 }
      : scope.excludeRecipientPhoneE164
        ? { recipientPhoneE164: { not: scope.excludeRecipientPhoneE164 } }
        : {}),
    ...(scope.trigger ? { trigger: scope.trigger } : {}),
    ...(scope.automationStage ? { automationStage: scope.automationStage } : {}),
    ...(scope.reportSubscriptionId
      ? { reportSubscriptionId: scope.reportSubscriptionId }
      : {}),
    ...(scope.serviceNoticeId ? { serviceNoticeId: scope.serviceNoticeId } : {}),
    ...(scope.purpose ? { purpose: scope.purpose } : {}),
  };
  const eligibility: Prisma.WhatsAppMessageWhereInput = {
    OR: [
      { status: "SCHEDULED" },
      { status: "CLAIMED", submissionStartedAt: null },
    ],
  };
  const studentScope: Prisma.WhatsAppMessageWhereInput | null = scope.studentId
    ? {
        OR: [
          { studentId: scope.studentId },
          {
            paymentSources: {
              some: { payment: { studentId: scope.studentId } },
            },
          },
        ],
      }
    : null;
  const paymentScope: Prisma.WhatsAppMessageWhereInput | null = scope.paymentId
    ? {
        OR: [
          { paymentId: scope.paymentId },
          { paymentSources: { some: { paymentId: scope.paymentId } } },
        ],
      }
    : null;

  return {
    ...scopeWhere,
    AND: [eligibility, ...(studentScope ? [studentScope] : []), ...(paymentScope ? [paymentScope] : [])],
  };
}

async function applyUnsubmittedMessageDisposition(
  tx: Prisma.TransactionClient,
  input: {
    scope: WhatsAppUnsubmittedMessageScope;
    reason: string;
    disposition: WhatsAppUnsubmittedMessageDisposition;
    now: Date;
  }
) {
  assertCancellationReason(input.reason);
  assertCancellationScope(input.scope);
  const where = unsubmittedMessageWhere(input.scope);
  const lifecycleData = input.disposition === "CANCELLED"
    ? { status: "CANCELLED" as const, cancelledAt: input.now }
    : { status: "SUPPRESSED" as const, suppressedAt: input.now };
  const reserved = await tx.whatsAppMessage.updateMany({
    where: {
      ...where,
      budgetState: "RESERVED",
    },
    data: {
      ...lifecycleData,
      failureCode: input.reason,
      budgetState: "RELEASED",
      leaseToken: null,
      leaseUntil: null,
    },
  });
  const unreserved = await tx.whatsAppMessage.updateMany({
    where: {
      ...where,
      budgetState: { not: "RESERVED" },
    },
    data: {
      ...lifecycleData,
      failureCode: input.reason,
      leaseToken: null,
      leaseUntil: null,
    },
  });

  return {
    disposition: input.disposition,
    affectedCount: reserved.count + unreserved.count,
    cancelledCount: reserved.count + unreserved.count,
    releasedReservationCount: reserved.count,
  };
}

async function associateStudentInTransaction(input: {
  actorUserId: string;
  scope: RecipientScope;
  student: RecipientStudent;
  relationship: WhatsAppRecipientRelationship;
  source: "IN_PERSON" | "IMPORT_ATTESTATION";
  writePerRecipientAudit: boolean;
  tx: Prisma.TransactionClient;
  now: Date;
}) {
  if (input.student.status !== "ACTIVE" || !input.student.phone) {
    throw new WhatsAppValidationError("Student is not eligible for WhatsApp association");
  }
  const phoneE164 = normalizeWhatsAppPhone(input.student.phone, { defaultCountry: "IN" });
  const consentResult = await WhatsAppConsentService.recordInTransaction(
    {
      actorUserId: input.actorUserId,
      branchId: input.scope.branchId,
      senderId: input.scope.senderId,
      phone: phoneE164,
      consentType: "OPERATIONAL",
      nextStatus: "OPTED_IN",
      source: input.source,
      policyVersion: WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
      details: {
        policyVersion: WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
        explicitAttestation: true,
      },
    },
    input.tx,
    {
      authorizationAlreadyVerified: true,
      writeAudit: input.writePerRecipientAudit,
    }
  );

  const existing = await input.tx.whatsAppStudentRecipient.findUnique({
    where: {
      studentId_senderId: {
        studentId: input.student.id,
        senderId: input.scope.senderId,
      },
    },
  });
  const unchanged = Boolean(
    existing
      && existing.organizationId === input.scope.organizationId
      && existing.branchId === input.scope.branchId
      && existing.consentId === consentResult.consent.id
      && existing.phoneE164 === phoneE164
      && existing.relationship === input.relationship
      && existing.status === "ACTIVE"
  );
  if (
    existing
    && (
      existing.organizationId !== input.scope.organizationId
      || existing.branchId !== input.scope.branchId
    )
  ) {
    throw new WhatsAppResourceNotFoundError();
  }

  const recipient = unchanged
    ? existing!
    : await input.tx.whatsAppStudentRecipient.upsert({
        where: {
          studentId_senderId: {
            studentId: input.student.id,
            senderId: input.scope.senderId,
          },
        },
        create: {
          organizationId: input.scope.organizationId,
          branchId: input.scope.branchId,
          studentId: input.student.id,
          senderId: input.scope.senderId,
          consentId: consentResult.consent.id,
          phoneE164,
          relationship: input.relationship,
          status: "ACTIVE",
          verifiedAt: input.now,
          createdByUserId: input.actorUserId,
        },
        update: {
            organizationId: input.scope.organizationId,
            branchId: input.scope.branchId,
            consentId: consentResult.consent.id,
            phoneE164,
            relationship: input.relationship,
            status: "ACTIVE",
            verifiedAt: input.now,
            staleAt: null,
            disabledAt: null,
            createdByUserId: input.actorUserId,
        },
      });

  if (!unchanged && input.writePerRecipientAudit) {
    await input.tx.whatsAppAuditEvent.create({
      data: {
        organizationId: input.scope.organizationId,
        branchId: input.scope.branchId,
        senderId: input.scope.senderId,
        actorUserId: input.actorUserId,
        action: "RECIPIENT_ASSOCIATED",
        details: {
          studentId: input.student.id,
          relationship: input.relationship,
          policyVersion: WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
        },
      },
    });
  }

  return {
    recipient: {
      id: recipient.id,
      studentId: recipient.studentId,
      relationship: recipient.relationship,
      status: recipient.status,
    },
    changed: !unchanged,
    consentChanged: consentResult.changed,
  };
}

export class WhatsAppRecipientService {
  static async getForStudent(input: {
    actorUserId: string;
    branchId: string;
    studentId: string;
  }) {
    assertBoundedId(input.studentId);
    assertWhatsAppDeliverySchemaAccessEnabled();
    await authorizeRecipientView(input.actorUserId, input.branchId);
    const providerMode = resolveWhatsAppProviderMode();
    const branch = await prisma.branch.findUnique({
      where: { id: input.branchId },
      select: { id: true, organizationId: true },
    });
    const student = branch
      ? await prisma.student.findFirst({
          where: { id: input.studentId, branchId: branch.id },
          select: { id: true, phone: true, status: true },
        })
      : null;
    if (!branch || !student) throw new WhatsAppResourceNotFoundError();
    const settings = await prisma.branchWhatsAppSettings.findFirst({
      where: { branchId: branch.id, organizationId: branch.organizationId },
      select: {
        sender: {
          select: {
            id: true,
            organizationId: true,
            providerMode: true,
            status: true,
            displayPhoneNumber: true,
            verifiedName: true,
          },
        },
      },
    });
    const sender = settings?.sender?.organizationId === branch.organizationId
      && settings.sender.providerMode === providerMode
      ? settings.sender
      : null;
    const recipient = sender
      ? await prisma.whatsAppStudentRecipient.findFirst({
          where: {
            organizationId: branch.organizationId,
            branchId: branch.id,
            studentId: student.id,
            senderId: sender.id,
          },
          select: {
            id: true,
            studentId: true,
            relationship: true,
            status: true,
            phoneE164: true,
            verifiedAt: true,
            staleAt: true,
            disabledAt: true,
            consent: {
              select: {
                status: true,
                consentType: true,
                source: true,
                policyVersion: true,
                grantedAt: true,
                revokedAt: true,
                updatedAt: true,
              },
            },
          },
        })
      : null;

    return {
      studentId: student.id,
      studentStatus: student.status,
      maskedPhone: maskRecipientPhone(student.phone),
      studentMaskedPhone: maskRecipientPhone(student.phone),
      assignedSender: sender
        ? {
            id: sender.id,
            status: sender.status,
            verifiedName: sender.verifiedName,
            maskedPhone: maskRecipientPhone(sender.displayPhoneNumber),
          }
        : null,
      recipient: recipient
        ? {
            id: recipient.id,
            studentId: recipient.studentId,
            relationship: recipient.relationship,
            status: recipient.status,
            consentStatus: recipient.consent.status,
            consentType: recipient.consent.consentType === "OPERATIONAL"
              ? "OPERATIONAL" as const
              : "UNKNOWN" as const,
            policyVersion: safeConsentPolicyVersion(recipient.consent.policyVersion),
            maskedPhone: maskRecipientPhone(recipient.phoneE164),
            phoneMatchesCurrentStudent: matchesCurrentStudentPhone(
              student.phone,
              recipient.phoneE164
            ),
            consentSource: recipient.consent.source,
            consentRecordedAt: safeIsoDate(
              recipient.consent.status === "OPTED_IN"
                ? recipient.consent.grantedAt ?? recipient.consent.updatedAt
                : recipient.consent.status === "OPTED_OUT"
                  ? recipient.consent.revokedAt ?? recipient.consent.updatedAt
                  : recipient.consent.updatedAt
            ),
            verifiedAt: safeIsoDate(recipient.verifiedAt),
            staleAt: safeIsoDate(recipient.staleAt),
            disabledAt: safeIsoDate(recipient.disabledAt),
          }
        : null,
    };
  }

  static async cancelUnsubmittedMessagesInTransaction(input: {
    tx: Prisma.TransactionClient;
    scope: WhatsAppUnsubmittedMessageScope;
    reason: string;
    disposition?: WhatsAppUnsubmittedMessageDisposition;
    now?: Date;
  }) {
    return applyUnsubmittedMessageDisposition(input.tx, {
      scope: input.scope,
      reason: input.reason,
      disposition: input.disposition ?? "CANCELLED",
      now: input.now ?? new Date(),
    });
  }

  static async associate(input: RecipientMutationInput & WhatsAppRecipientSelection) {
    assertAttestation(input.attestation);
    assertBoundedId(input.studentId);
    assertRelationship(input.relationship);
    assertWhatsAppDeliverySchemaAccessEnabled();
    await authorizeRecipientMutation(input.actorUserId, input.branchId);

    return prisma.$transaction(async tx => {
      await authorizeRecipientMutation(input.actorUserId, input.branchId, tx);
      const scope = await resolveCurrentRecipientScope(tx, input.branchId);
      const student = await tx.student.findFirst({
        where: { id: input.studentId, branchId: input.branchId },
        select: { id: true, branchId: true, phone: true, status: true },
      });
      if (!student) throw new WhatsAppResourceNotFoundError();

      return associateStudentInTransaction({
        actorUserId: input.actorUserId,
        scope,
        student,
        relationship: input.relationship,
        source: "IN_PERSON",
        writePerRecipientAudit: true,
        tx,
        now: new Date(),
      });
    });
  }

  static async associateBulk(input: RecipientMutationInput & {
    recipients: WhatsAppRecipientSelection[];
  }) {
    assertAttestation(input.attestation);
    if (
      !Array.isArray(input.recipients)
      || input.recipients.length < 1
      || input.recipients.length > MAX_WHATSAPP_RECIPIENT_BULK_SIZE
    ) {
      throw new WhatsAppValidationError();
    }
    const studentIds = new Set<string>();
    for (const recipient of input.recipients) {
      assertBoundedId(recipient.studentId);
      assertRelationship(recipient.relationship);
      if (studentIds.has(recipient.studentId)) throw new WhatsAppValidationError();
      studentIds.add(recipient.studentId);
    }
    assertWhatsAppDeliverySchemaAccessEnabled();
    await authorizeRecipientMutation(input.actorUserId, input.branchId);

    return prisma.$transaction(async tx => {
      await authorizeRecipientMutation(input.actorUserId, input.branchId, tx);
      const scope = await resolveCurrentRecipientScope(tx, input.branchId);
      const students = await tx.student.findMany({
        where: { branchId: input.branchId, id: { in: [...studentIds] } },
        select: { id: true, branchId: true, phone: true, status: true },
      });
      if (students.length !== studentIds.size) throw new WhatsAppResourceNotFoundError();
      const studentsById = new Map(students.map(student => [student.id, student]));
      const skipped: Array<{ studentId: string; reason: "STUDENT_INACTIVE" | "NO_PHONE" | "INVALID_PHONE" }> = [];
      let associatedCount = 0;
      let unchangedCount = 0;

      for (const selection of input.recipients) {
        const student = studentsById.get(selection.studentId)!;
        if (student.status !== "ACTIVE") {
          skipped.push({ studentId: student.id, reason: "STUDENT_INACTIVE" });
          continue;
        }
        if (!student.phone) {
          skipped.push({ studentId: student.id, reason: "NO_PHONE" });
          continue;
        }
        try {
          normalizeWhatsAppPhone(student.phone, { defaultCountry: "IN" });
        } catch {
          skipped.push({ studentId: student.id, reason: "INVALID_PHONE" });
          continue;
        }

        const result = await associateStudentInTransaction({
          actorUserId: input.actorUserId,
          scope,
          student,
          relationship: selection.relationship,
          source: "IMPORT_ATTESTATION",
          writePerRecipientAudit: false,
          tx,
          now: new Date(),
        });
        if (result.changed) associatedCount += 1;
        else unchangedCount += 1;
      }

      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          senderId: scope.senderId,
          actorUserId: input.actorUserId,
          action: "BULK_OPERATIONAL_CONSENT_RECORDED",
          details: {
            policyVersion: WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
            requestedCount: input.recipients.length,
            associatedCount,
            unchangedCount,
            skippedCount: skipped.length,
          },
        },
      });

      return {
        requestedCount: input.recipients.length,
        associatedCount,
        unchangedCount,
        skipped,
      };
    });
  }

  static async disable(input: {
    actorUserId: string;
    branchId: string;
    recipientId: string;
  }) {
    assertBoundedId(input.recipientId);
    assertWhatsAppDeliverySchemaAccessEnabled();
    await authorizeRecipientMutation(input.actorUserId, input.branchId);

    return prisma.$transaction(async tx => {
      await authorizeRecipientMutation(input.actorUserId, input.branchId, tx);
      const recipient = await tx.whatsAppStudentRecipient.findFirst({
        where: { id: input.recipientId, branchId: input.branchId },
        select: {
          id: true,
          organizationId: true,
          branchId: true,
          senderId: true,
          phoneE164: true,
          consentId: true,
        },
      });
      if (!recipient) throw new WhatsAppResourceNotFoundError();
      const branch = await tx.branch.findFirst({
        where: {
          id: recipient.branchId,
          organizationId: recipient.organizationId,
        },
        select: { id: true },
      });
      if (!branch) throw new WhatsAppResourceNotFoundError();
      const now = new Date();
      const consentResult = await WhatsAppConsentService.recordInTransaction(
        {
          actorUserId: input.actorUserId,
          branchId: recipient.branchId,
          senderId: recipient.senderId,
          phone: recipient.phoneE164,
          consentType: "OPERATIONAL",
          nextStatus: "OPTED_OUT",
          source: "OWNER_CONFIGURATION",
          policyVersion: WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
          details: {
            policyVersion: WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
            reason: "DASHBOARD_OPT_OUT",
          },
        },
        tx,
        {
          authorizationAlreadyVerified: true,
          requireActiveSender: false,
          writeAudit: false,
        }
      );
      if (consentResult.consent.id !== recipient.consentId) {
        throw new WhatsAppResourceNotFoundError();
      }
      const disabled = await tx.whatsAppStudentRecipient.updateMany({
        where: {
          organizationId: recipient.organizationId,
          senderId: recipient.senderId,
          phoneE164: recipient.phoneE164,
          status: { not: "DISABLED" },
        },
        data: { status: "DISABLED", disabledAt: now },
      });
      const cancellation = await this.cancelUnsubmittedMessagesInTransaction({
        tx,
        scope: {
          organizationId: recipient.organizationId,
          senderId: recipient.senderId,
          recipientPhoneE164: recipient.phoneE164,
        },
        reason: "OPERATIONAL_CONSENT_OPTED_OUT",
        now,
      });

      if (disabled.count > 0 || consentResult.changed || cancellation.cancelledCount > 0) {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: recipient.organizationId,
            branchId: recipient.branchId,
            senderId: recipient.senderId,
            actorUserId: input.actorUserId,
            action: "RECIPIENT_DISABLED",
            details: {
              reason: "OPERATIONAL_CONSENT_OPTED_OUT",
              disabledCount: disabled.count,
              cancelledMessageCount: cancellation.cancelledCount,
              releasedReservationCount: cancellation.releasedReservationCount,
            },
          },
        });
      }

      return {
        recipientId: recipient.id,
        changed: disabled.count > 0 || consentResult.changed,
        disabledCount: disabled.count,
        cancelledMessageCount: cancellation.cancelledCount,
      };
    });
  }

  static async reconcileStudentPhoneChangeInTransaction(input: {
    tx: Prisma.TransactionClient;
    actorUserId: string;
    branchId: string;
    studentId: string;
    newPhone: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const newPhoneE164 = normalizeWhatsAppPhone(input.newPhone, { defaultCountry: "IN" });
    const mappings = await input.tx.whatsAppStudentRecipient.findMany({
      where: {
        branchId: input.branchId,
        studentId: input.studentId,
        status: "ACTIVE",
        phoneE164: { not: newPhoneE164 },
      },
      select: { id: true, organizationId: true, branchId: true, senderId: true },
    });
    if (mappings.length > 0) {
      await input.tx.whatsAppStudentRecipient.updateMany({
        where: { id: { in: mappings.map(mapping => mapping.id) }, status: "ACTIVE" },
        data: { status: "STALE", staleAt: now },
      });
      await input.tx.whatsAppAuditEvent.createMany({
        data: mappings.map(mapping => ({
          organizationId: mapping.organizationId,
          branchId: mapping.branchId,
          senderId: mapping.senderId,
          actorUserId: input.actorUserId,
          action: "RECIPIENT_MARKED_STALE" as const,
          details: { studentId: input.studentId, reason: "STUDENT_PHONE_CHANGED" },
        })),
      });
    }
    const cancellation = await this.cancelUnsubmittedMessagesInTransaction({
      tx: input.tx,
      scope: {
        branchId: input.branchId,
        studentId: input.studentId,
        excludeRecipientPhoneE164: newPhoneE164,
      },
      reason: "STUDENT_PHONE_CHANGED",
      now,
    });

    return { staleCount: mappings.length, ...cancellation };
  }

  static async reconcileStudentInactivationInTransaction(input: {
    tx: Prisma.TransactionClient;
    actorUserId: string;
    branchId: string;
    studentId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const mappings = await input.tx.whatsAppStudentRecipient.findMany({
      where: {
        branchId: input.branchId,
        studentId: input.studentId,
        status: "ACTIVE",
      },
      select: { id: true, organizationId: true, branchId: true, senderId: true },
    });
    if (mappings.length > 0) {
      await input.tx.whatsAppStudentRecipient.updateMany({
        where: { id: { in: mappings.map(mapping => mapping.id) }, status: "ACTIVE" },
        data: { status: "DISABLED", disabledAt: now },
      });
      await input.tx.whatsAppAuditEvent.createMany({
        data: mappings.map(mapping => ({
          organizationId: mapping.organizationId,
          branchId: mapping.branchId,
          senderId: mapping.senderId,
          actorUserId: input.actorUserId,
          action: "RECIPIENT_DISABLED" as const,
          details: { studentId: input.studentId, reason: "STUDENT_INACTIVE" },
        })),
      });
    }
    const cancellation = await this.cancelUnsubmittedMessagesInTransaction({
      tx: input.tx,
      scope: { branchId: input.branchId, studentId: input.studentId },
      reason: "STUDENT_INACTIVE",
      now,
    });

    return { disabledCount: mappings.length, ...cancellation };
  }

  /**
   * Shared opt-out primitive for webhook projection. The caller is responsible
   * for authenticating the provider event and resolving the exact sender/phone.
   */
  static async disableSenderPhoneInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    senderId: string;
    phoneE164: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const disabled = await input.tx.whatsAppStudentRecipient.updateMany({
      where: {
        organizationId: input.organizationId,
        senderId: input.senderId,
        phoneE164: input.phoneE164,
        status: { not: "DISABLED" },
      },
      data: { status: "DISABLED", disabledAt: now },
    });
    const cancellation = await this.cancelUnsubmittedMessagesInTransaction({
      tx: input.tx,
      scope: {
        organizationId: input.organizationId,
        senderId: input.senderId,
        recipientPhoneE164: input.phoneE164,
      },
      reason: "OPERATIONAL_CONSENT_OPTED_OUT",
      now,
    });
    return { disabledCount: disabled.count, ...cancellation };
  }
}
