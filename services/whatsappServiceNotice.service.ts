import {
  Prisma,
  type WhatsAppServiceNotice,
  type WhatsAppServiceNoticeStatus,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertWhatsAppMessageWritesEnabled,
  assertWhatsAppServiceNoticesEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  assertWhatsAppRateCardCurrent,
  estimateWhatsAppUtilityCostMicros,
  paiseToInrMicros,
  readWhatsAppRateCard,
  validateWhatsAppMonthlyBudgetMinor,
} from "@/lib/whatsappCost";
import {
  getManagedWhatsAppTemplate,
  managedProviderTemplateMatches,
  prepareManagedWhatsAppTemplate,
  type WhatsAppManagedTemplateLanguage,
} from "@/lib/whatsappManagedTemplates";
import {
  WhatsAppConflictError,
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import {
  createWhatsAppServiceNoticeMessageKey,
  createWhatsAppServiceNoticeRequestHash,
  createWhatsAppServiceNoticeSourceFingerprint,
  managedTemplateKeyForServiceNotice,
  MAX_WHATSAPP_SERVICE_NOTICE_RECIPIENTS,
  resolveWhatsAppServiceNoticeDraft,
  serviceNoticeHasExpired,
  serviceNoticeLocalScheduleDate,
  serviceNoticeTemplateValues,
  type WhatsAppServiceNoticeDraft,
} from "@/lib/whatsappServiceNotice";
import {
  getWhatsAppLocalDateTimeParts,
  whatsappBudgetMonth,
  whatsappLocalDateKey,
} from "@/lib/whatsappSchedule";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import { WhatsAppRecipientService } from "@/services/whatsappRecipient.service";

type PrismaClient = Prisma.TransactionClient | typeof prisma;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ELIGIBLE_PHONE_PATTERN = /^\+91[6-9]\d{9}$/;
const ESTIMATE_DISCLAIMER =
  "Estimated Meta usage for messages sent through Lab Lords. Final charges are determined by Meta in the customer’s Meta account.";

type EligiblePhoneRow = { phoneE164: string };
type AudienceCountRow = { eligibleCount: number; suppressedCount: number };

function isGenericAuthorizationFailure(error: unknown) {
  return error instanceof Error
    && (error.message === "Branch not found" || error.message.startsWith("Unauthorized:"));
}

function assertId(value: string) {
  if (!ID_PATTERN.test(value)) throw new WhatsAppValidationError();
  return value;
}

function assertIdempotencyKey(value: string) {
  if (!IDEMPOTENCY_PATTERN.test(value)) throw new WhatsAppValidationError();
  return value;
}

function normalizeLanguage(value: string): WhatsAppManagedTemplateLanguage {
  if (value === "en") return "en_IN";
  if (value === "en_IN" || value === "hi") return value;
  throw new WhatsAppValidationError("Unsupported WhatsApp language");
}

async function authorizeNoticeBranch(input: {
  actorUserId: string;
  branchId: string;
  client?: PrismaClient;
  writable: boolean;
}) {
  const client = input.client ?? prisma;
  try {
    await StaffService.authorize(input.actorUserId, input.branchId, "manage_whatsapp", client);
    await StaffService.authorize(input.actorUserId, input.branchId, "send_whatsapp", client);
    await StaffService.authorize(input.actorUserId, input.branchId, "view_whatsapp", client);
  } catch (error) {
    if (isGenericAuthorizationFailure(error)) throw new WhatsAppResourceNotFoundError();
    throw error;
  }
  await EntitlementService.assertBranchEntitlement(
    input.branchId,
    "WHATSAPP_AUTOMATION",
    client
  );
  if (input.writable) await EntitlementService.assertBranchWritable(input.branchId, client);
}

async function currentNoticeSettings(branchId: string, client: PrismaClient) {
  const providerMode = resolveWhatsAppProviderMode();
  const settings = await client.branchWhatsAppSettings.findFirst({
    where: {
      branchId,
      enabled: true,
      senderId: { not: null },
    },
    include: {
      branch: {
        select: {
          id: true,
          name: true,
          organizationId: true,
          organization: { select: { timezone: true } },
        },
      },
      sender: {
        select: {
          id: true,
          organizationId: true,
          provider: true,
          providerMode: true,
          status: true,
          safetyState: { select: { pausedAt: true, pauseRequestedAt: true } },
        },
      },
    },
  });
  if (
    !settings
    || settings.organizationId !== settings.branch.organizationId
    || !settings.sender
    || settings.sender.organizationId !== settings.organizationId
    || settings.sender.provider !== "META_CLOUD"
    || settings.sender.providerMode !== providerMode
    || settings.sender.status !== "ACTIVE"
    || settings.sender.safetyState?.pausedAt
    || settings.sender.safetyState?.pauseRequestedAt
  ) throw new WhatsAppResourceNotFoundError();
  return settings;
}

async function eligibleAudience(input: {
  client: PrismaClient;
  organizationId: string;
  branchId: string;
  senderId: string;
}) {
  const phones = await input.client.$queryRaw<EligiblePhoneRow[]>(Prisma.sql`
    SELECT recipient."phoneE164" AS "phoneE164"
    FROM "WhatsAppStudentRecipient" recipient
    INNER JOIN "Student" student
      ON student."id" = recipient."studentId"
      AND student."branchId" = recipient."branchId"
    INNER JOIN "WhatsAppConsent" consent
      ON consent."id" = recipient."consentId"
      AND consent."senderId" = recipient."senderId"
      AND consent."phoneE164" = recipient."phoneE164"
    WHERE recipient."organizationId" = ${input.organizationId}
      AND recipient."branchId" = ${input.branchId}
      AND recipient."senderId" = ${input.senderId}
      AND recipient."status" = 'ACTIVE'
      AND student."status" = 'ACTIVE'
      AND consent."consentType" = 'OPERATIONAL'
      AND consent."status" = 'OPTED_IN'
      AND recipient."phoneE164" ~ '^\\+91[6-9][0-9]{9}$'
    GROUP BY recipient."phoneE164"
    ORDER BY recipient."phoneE164" ASC
    LIMIT ${MAX_WHATSAPP_SERVICE_NOTICE_RECIPIENTS + 1}
  `);
  if (phones.length > MAX_WHATSAPP_SERVICE_NOTICE_RECIPIENTS) {
    throw new WhatsAppValidationError(
      "The eligible branch audience exceeds the protected limit of 500 unique phones"
    );
  }
  if (phones.some(row => !ELIGIBLE_PHONE_PATTERN.test(row.phoneE164))) {
    throw new WhatsAppValidationError();
  }
  const countRows = await input.client.$queryRaw<AudienceCountRow[]>(Prisma.sql`
    SELECT
      COUNT(DISTINCT recipient."phoneE164") FILTER (
        WHERE consent."id" IS NOT NULL
          AND recipient."phoneE164" ~ '^\\+91[6-9][0-9]{9}$'
      )::int AS "eligibleCount",
      COUNT(DISTINCT recipient."phoneE164") FILTER (
        WHERE consent."id" IS NULL
          OR recipient."phoneE164" !~ '^\\+91[6-9][0-9]{9}$'
      )::int AS "suppressedCount"
    FROM "WhatsAppStudentRecipient" recipient
    INNER JOIN "Student" student
      ON student."id" = recipient."studentId"
      AND student."branchId" = recipient."branchId"
    LEFT JOIN "WhatsAppConsent" consent
      ON consent."id" = recipient."consentId"
      AND consent."senderId" = recipient."senderId"
      AND consent."phoneE164" = recipient."phoneE164"
      AND consent."consentType" = 'OPERATIONAL'
      AND consent."status" = 'OPTED_IN'
    WHERE recipient."organizationId" = ${input.organizationId}
      AND recipient."branchId" = ${input.branchId}
      AND recipient."senderId" = ${input.senderId}
      AND recipient."status" = 'ACTIVE'
      AND student."status" = 'ACTIVE'
  `);
  const counts = countRows[0] ?? { eligibleCount: phones.length, suppressedCount: 0 };
  if (
    !Number.isSafeInteger(counts.eligibleCount)
    || !Number.isSafeInteger(counts.suppressedCount)
    || counts.eligibleCount !== phones.length
    || counts.suppressedCount < 0
  ) throw new WhatsAppValidationError();
  return { phones: phones.map(row => row.phoneE164), suppressedCount: counts.suppressedCount };
}

async function resolveBinding(input: {
  client: PrismaClient;
  senderId: string;
  managedTemplateKey: ReturnType<typeof resolveWhatsAppServiceNoticeDraft>["managedTemplateKey"];
  language: WhatsAppManagedTemplateLanguage;
}) {
  const definition = getManagedWhatsAppTemplate(input.managedTemplateKey, input.language);
  const binding = await input.client.whatsAppTemplateBinding.findUnique({
    where: {
      senderId_managedKey_language: {
        senderId: input.senderId,
        managedKey: input.managedTemplateKey,
        language: input.language,
      },
    },
    include: { template: true, provisioning: true },
  });
  if (
    !binding
    || !binding.active
    || binding.catalogVersion !== definition.catalogVersion
    || binding.catalogHash !== definition.catalogHash
    || binding.provisioning.status !== "READY"
    || binding.template.providerStatus !== "APPROVED"
    || binding.template.category !== "UTILITY"
    || binding.template.staleAt !== null
    || !Array.isArray(binding.template.components)
    || !managedProviderTemplateMatches({
      name: binding.template.name,
      language: binding.template.language,
      category: binding.template.category,
      components: binding.template.components,
    }, definition)
  ) throw new WhatsAppValidationError("Required approved Utility template is unavailable");
  return { definition, binding };
}

async function lockBranchSettings(tx: Prisma.TransactionClient, branchId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "branchId"
    FROM "BranchWhatsAppSettings"
    WHERE "branchId" = ${branchId}
    FOR UPDATE
  `);
}

async function buildNoticePreview(input: {
  actorUserId: string;
  branchId: string;
  draft: WhatsAppServiceNoticeDraft;
  client: PrismaClient;
  now: Date;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  await authorizeNoticeBranch({ ...input, writable: true });
  const settings = await currentNoticeSettings(input.branchId, input.client);
  const timeZone = settings.branch.organization.timezone;
  const resolved = resolveWhatsAppServiceNoticeDraft({
    draft: input.draft,
    now: input.now,
    timeZone,
    branchSendTimeLocal: settings.sendTimeLocal,
  });
  const language = normalizeLanguage(settings.defaultLanguage);
  const { definition, binding } = await resolveBinding({
    client: input.client,
    senderId: settings.sender!.id,
    managedTemplateKey: resolved.managedTemplateKey,
    language,
  });
  const audience = await eligibleAudience({
    client: input.client,
    organizationId: settings.organizationId,
    branchId: settings.branchId,
    senderId: settings.sender!.id,
  });
  if (audience.phones.length === 0) {
    throw new WhatsAppValidationError("No eligible operational recipients are available");
  }
  const rateCard = assertWhatsAppRateCardCurrent(readWhatsAppRateCard(input.env), input.now);
  assertWhatsAppRateCardCurrent(rateCard, resolved.scheduledFor);
  const estimatedCostMicros = estimateWhatsAppUtilityCostMicros({
    messageCount: audience.phones.length,
    rateMicros: rateCard.rateMicros,
  });
  const budgetMicros = paiseToInrMicros(
    validateWhatsAppMonthlyBudgetMinor(settings.monthlyBudgetMinor)
  );
  const budgetMonth = whatsappBudgetMonth(resolved.scheduledFor, timeZone);
  const used = await input.client.whatsAppMessage.aggregate({
    where: {
      branchId: input.branchId,
      budgetMonth,
      budgetState: { in: ["RESERVED", "COMMITTED"] },
    },
    _sum: { estimatedCostMicros: true },
  });
  const usedMicros = used._sum.estimatedCostMicros ?? 0n;
  const remainingAfter = BigInt(budgetMicros) - usedMicros - BigInt(estimatedCostMicros);
  if (remainingAfter < 0n) {
    throw new WhatsAppValidationError("The branch WhatsApp budget is unavailable");
  }
  const values = serviceNoticeTemplateValues({
    draft: input.draft,
    branchName: settings.branch.name,
    language,
  });
  const prepared = prepareManagedWhatsAppTemplate(definition, values);
  return {
    settings,
    timeZone,
    language,
    resolved,
    binding,
    values,
    prepared,
    audience,
    rateCard,
    budgetMonth,
    estimatedCostMicros,
    budgetRemainingAfterMicros: remainingAfter,
  };
}

function publicPreview(result: Awaited<ReturnType<typeof buildNoticePreview>>) {
  return {
    renderedPreview: result.prepared.renderedPreview,
    eligibleRecipientCount: result.audience.phones.length,
    suppressedCount: result.audience.suppressedCount,
    estimatedCostMicros: String(result.estimatedCostMicros),
    currency: "INR" as const,
    rateCardVersion: result.rateCard.version,
    scheduledFor: result.resolved.scheduledFor.toISOString(),
    budgetRemainingAfterMicros: result.budgetRemainingAfterMicros.toString(),
    estimateDisclaimer: ESTIMATE_DISCLAIMER,
  };
}

function serializeNotice(notice: WhatsAppServiceNotice, canCancel?: boolean) {
  return {
    id: notice.id,
    type: notice.type,
    reason: notice.reason,
    localEffectiveDate: notice.localEffectiveDate,
    status: notice.status,
    eligibleRecipientCount: notice.eligibleRecipientCount,
    queuedMessageCount: notice.queuedMessageCount,
    suppressedCount: notice.suppressedCount,
    scheduledFor: notice.scheduledFor.toISOString(),
    estimatedCostMicros: notice.estimatedCostMicros.toString(),
    rateCardVersion: notice.rateCardVersion,
    canCancel: canCancel ?? false,
    queuedAt: notice.queuedAt?.toISOString() ?? null,
    cancelledAt: notice.cancelledAt?.toISOString() ?? null,
    completedAt: notice.completedAt?.toISOString() ?? null,
    createdAt: notice.createdAt.toISOString(),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function storedNoticeDraft(input: {
  notice: WhatsAppServiceNotice;
  timeZone: string;
}): WhatsAppServiceNoticeDraft {
  const time = (value: Date | null) => {
    if (!value) return null;
    const local = getWhatsAppLocalDateTimeParts(value, input.timeZone);
    return `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  };
  return {
    type: input.notice.type,
    reason: input.notice.reason,
    localEffectiveDate: input.notice.localEffectiveDate,
    resumeLocalDate: input.notice.resumeAt
      ? whatsappLocalDateKey(input.notice.resumeAt, input.timeZone)
      : null,
    openingTimeLocal: input.notice.type === "HOURS_CHANGED"
      ? time(input.notice.effectiveStartAt)
      : null,
    closingTimeLocal: input.notice.type === "HOURS_CHANGED"
      ? time(input.notice.effectiveEndAt)
      : null,
    maintenanceStartTimeLocal: input.notice.type === "MAINTENANCE_WINDOW"
      ? time(input.notice.effectiveStartAt)
      : null,
    maintenanceEndTimeLocal: input.notice.type === "MAINTENANCE_WINDOW"
      ? time(input.notice.effectiveEndAt)
      : null,
    delivery: "IMMEDIATE",
    scheduledForLocal: null,
  };
}

export async function verifyWhatsAppServiceNoticeSource(input: {
  tx: Prisma.TransactionClient;
  messageId: string;
  now: Date;
}): Promise<
  | { valid: true; language: WhatsAppManagedTemplateLanguage }
  | { valid: false; code: string }
> {
  const message = await input.tx.whatsAppMessage.findUnique({
    where: { id: input.messageId },
    include: {
      serviceNotice: true,
      templateBinding: { select: { id: true, language: true } },
      branch: {
        select: {
          id: true,
          name: true,
          organizationId: true,
          organization: { select: { timezone: true } },
          whatsAppSettings: {
            select: { organizationId: true, senderId: true, enabled: true, configurationRevision: true },
          },
        },
      },
    },
  });
  if (
    !message
    || message.purpose !== "SERVICE_NOTICE"
    || !message.branchId
    || !message.serviceNotice
    || !message.templateBinding
    || !message.branch
    || !message.branch.whatsAppSettings
  ) return { valid: false, code: "NOTICE_SOURCE_MISSING" };
  const notice = message.serviceNotice;
  const settings = message.branch.whatsAppSettings;
  if (
    notice.organizationId !== message.organizationId
    || notice.branchId !== message.branchId
    || notice.senderId !== message.senderId
    || message.branch.organizationId !== message.organizationId
    || settings.organizationId !== message.organizationId
    || settings.senderId !== message.senderId
    || !settings.enabled
  ) return { valid: false, code: "NOTICE_SCOPE_CHANGED" };
  if (notice.status === "CANCELLED" || notice.status === "FAILED" || notice.cancelledAt) {
    return { valid: false, code: "NOTICE_CANCELLED" };
  }
  if (notice.scheduledFor.getTime() !== message.scheduledFor.getTime()) {
    return { valid: false, code: "NOTICE_SCHEDULE_CHANGED" };
  }
  if (serviceNoticeHasExpired({
    type: notice.type,
    localEffectiveDate: notice.localEffectiveDate,
    effectiveEndAt: notice.effectiveEndAt,
    resumeAt: notice.resumeAt,
    now: input.now,
    timeZone: message.branch.organization.timezone,
  })) return { valid: false, code: "NOTICE_EXPIRED" };
  const mapping = await input.tx.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "WhatsAppStudentRecipient" recipient
      INNER JOIN "Student" student
        ON student."id" = recipient."studentId"
        AND student."branchId" = recipient."branchId"
      INNER JOIN "WhatsAppConsent" consent
        ON consent."id" = recipient."consentId"
        AND consent."senderId" = recipient."senderId"
        AND consent."phoneE164" = recipient."phoneE164"
      WHERE recipient."organizationId" = ${message.organizationId}
        AND recipient."branchId" = ${message.branchId}
        AND recipient."senderId" = ${message.senderId}
        AND recipient."phoneE164" = ${message.recipientPhoneE164}
        AND recipient."status" = 'ACTIVE'
        AND student."status" = 'ACTIVE'
        AND consent."consentType" = 'OPERATIONAL'
        AND consent."status" = 'OPTED_IN'
    ) AS "present"
  `);
  if (mapping[0]?.present !== true) return { valid: false, code: "NOTICE_RECIPIENT_STALE" };
  let language: WhatsAppManagedTemplateLanguage;
  try {
    language = normalizeLanguage(message.templateBinding.language);
  } catch {
    return { valid: false, code: "NOTICE_TEMPLATE_LANGUAGE_CHANGED" };
  }
  const draft = storedNoticeDraft({ notice, timeZone: message.branch.organization.timezone });
  const values = serviceNoticeTemplateValues({
    draft,
    branchName: message.branch.name,
    language,
  });
  if (JSON.stringify(canonical(message.templateVariables)) !== JSON.stringify(canonical(values))) {
    return { valid: false, code: "NOTICE_VARIABLES_CHANGED" };
  }
  if (
    !message.managedTemplateKey
    || !message.catalogHash
    || managedTemplateKeyForServiceNotice(notice.type) !== message.managedTemplateKey
  ) {
    return { valid: false, code: "NOTICE_TEMPLATE_MISSING" };
  }
  const fingerprint = createWhatsAppServiceNoticeSourceFingerprint({
    noticeId: notice.id,
    organizationId: notice.organizationId,
    branchId: notice.branchId,
    branchName: message.branch.name,
    senderId: notice.senderId,
    recipientPhoneE164: message.recipientPhoneE164,
    type: notice.type,
    reason: notice.reason,
    localEffectiveDate: notice.localEffectiveDate,
    effectiveStartAt: notice.effectiveStartAt,
    effectiveEndAt: notice.effectiveEndAt,
    resumeAt: notice.resumeAt,
    scheduledFor: notice.scheduledFor,
    templateBindingId: message.templateBinding.id,
    managedTemplateKey: message.managedTemplateKey,
    catalogHash: message.catalogHash,
    settingsRevision: settings.configurationRevision,
    templateVariables: values,
  });
  if (fingerprint !== message.sourceFingerprint) {
    return { valid: false, code: "NOTICE_SOURCE_CHANGED" };
  }
  return { valid: true, language };
}

export class WhatsAppServiceNoticeService {
  static async preview(input: {
    actorUserId: string;
    branchId: string;
    draft: WhatsAppServiceNoticeDraft;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppServiceNoticesEnabled(input.env);
    const result = await buildNoticePreview({
      ...input,
      client: prisma,
      now: input.now ?? new Date(),
    });
    return publicPreview(result);
  }

  static async queue(input: {
    actorUserId: string;
    branchId: string;
    draft: WhatsAppServiceNoticeDraft;
    idempotencyKey: string;
    confirmCustomerCharge: boolean;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    if (input.confirmCustomerCharge !== true) throw new WhatsAppValidationError();
    assertWhatsAppServiceNoticesEnabled(input.env);
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const requestHash = createWhatsAppServiceNoticeRequestHash({
      branchId: assertId(input.branchId),
      draft: input.draft,
    });
    const now = input.now ?? new Date();
    await authorizeNoticeBranch({ ...input, client: prisma, writable: true });
    return prisma.$transaction(async tx => {
      await authorizeNoticeBranch({ ...input, client: tx, writable: true });
      await lockBranchSettings(tx, input.branchId);
      const existing = await tx.whatsAppServiceNotice.findUnique({
        where: { branchId_idempotencyKey: { branchId: input.branchId, idempotencyKey } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new WhatsAppConflictError("Idempotency-Key was already used for another request");
        }
        return {
          replayed: true as const,
          noticeId: existing.id,
          status: existing.status,
          queuedMessageCount: existing.queuedMessageCount,
          suppressedCount: existing.suppressedCount,
        };
      }
      const preview = await buildNoticePreview({ ...input, client: tx, now });
      assertWhatsAppMessageWritesEnabled(preview.settings.organizationId, input.env);
      const notice = await tx.whatsAppServiceNotice.create({
        data: {
          organizationId: preview.settings.organizationId,
          branchId: input.branchId,
          senderId: preview.settings.sender!.id,
          actorUserId: input.actorUserId,
          idempotencyKey,
          requestHash,
          type: input.draft.type,
          reason: input.draft.reason,
          localEffectiveDate: preview.resolved.localEffectiveDate,
          effectiveStartAt: preview.resolved.effectiveStartAt,
          effectiveEndAt: preview.resolved.effectiveEndAt,
          resumeAt: preview.resolved.resumeAt,
          scheduledFor: preview.resolved.scheduledFor,
          status: "QUEUED",
          eligibleRecipientCount: preview.audience.phones.length,
          queuedMessageCount: preview.audience.phones.length,
          suppressedCount: preview.audience.suppressedCount,
          estimatedCostMicros: BigInt(preview.estimatedCostMicros),
          rateCardVersion: preview.rateCard.version,
          queuedAt: now,
        },
      });
      await tx.whatsAppMessage.createMany({
        data: preview.audience.phones.map(phoneE164 => ({
          organizationId: preview.settings.organizationId,
          branchId: input.branchId,
          senderId: preview.settings.sender!.id,
          templateId: preview.binding.templateId,
          templateBindingId: preview.binding.id,
          serviceNoticeId: notice.id,
          createdByUserId: input.actorUserId,
          recipientPhoneE164: phoneE164,
          purpose: "SERVICE_NOTICE" as const,
          trigger: "MANUAL" as const,
          managedTemplateKey: preview.resolved.managedTemplateKey,
          catalogVersion: preview.binding.catalogVersion,
          catalogHash: preview.binding.catalogHash,
          templateVersion: preview.binding.template.version,
          templateVariables: preview.values,
          renderedPreview: preview.prepared.renderedPreview,
          scheduledFor: preview.resolved.scheduledFor,
          availableAt: preview.resolved.scheduledFor,
          localScheduleDate: serviceNoticeLocalScheduleDate(
            preview.resolved.scheduledFor,
            preview.timeZone
          ),
          status: "SCHEDULED" as const,
          dedupeKey: createWhatsAppServiceNoticeMessageKey({
            kind: "dedupe",
            noticeId: notice.id,
            senderId: preview.settings.sender!.id,
            recipientPhoneE164: phoneE164,
          }),
          frequencyKey: createWhatsAppServiceNoticeMessageKey({
            kind: "frequency",
            noticeId: notice.id,
            senderId: preview.settings.sender!.id,
            recipientPhoneE164: phoneE164,
          }),
          settingsRevision: preview.settings.configurationRevision,
          sourceFingerprint: createWhatsAppServiceNoticeSourceFingerprint({
            noticeId: notice.id,
            organizationId: preview.settings.organizationId,
            branchId: input.branchId,
            branchName: preview.settings.branch.name,
            senderId: preview.settings.sender!.id,
            recipientPhoneE164: phoneE164,
            type: notice.type,
            reason: notice.reason,
            localEffectiveDate: notice.localEffectiveDate,
            effectiveStartAt: notice.effectiveStartAt,
            effectiveEndAt: notice.effectiveEndAt,
            resumeAt: notice.resumeAt,
            scheduledFor: notice.scheduledFor,
            templateBindingId: preview.binding.id,
            managedTemplateKey: preview.resolved.managedTemplateKey,
            catalogHash: preview.binding.catalogHash,
            settingsRevision: preview.settings.configurationRevision,
            templateVariables: preview.values,
          }),
          budgetMonth: preview.budgetMonth,
          budgetState: "RESERVED" as const,
          rateCardVersion: preview.rateCard.version,
          estimatedCostMicros: BigInt(preview.rateCard.rateMicros),
          currency: "INR",
        })),
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: preview.settings.organizationId,
          branchId: input.branchId,
          senderId: preview.settings.sender!.id,
          actorUserId: input.actorUserId,
          action: "SERVICE_NOTICE_QUEUED",
          details: {
            noticeType: notice.type,
            eligibleRecipientCount: notice.eligibleRecipientCount,
            queuedMessageCount: notice.queuedMessageCount,
            suppressedCount: notice.suppressedCount,
            rateCardVersion: notice.rateCardVersion,
          },
        },
      });
      return {
        replayed: false as const,
        noticeId: notice.id,
        status: notice.status,
        queuedMessageCount: notice.queuedMessageCount,
        suppressedCount: notice.suppressedCount,
        preview: publicPreview(preview),
      };
    }, { isolationLevel: "Serializable" });
  }

  static async list(input: {
    actorUserId: string;
    branchId: string;
    limit?: number;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppServiceNoticesEnabled(input.env);
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new WhatsAppValidationError();
    }
    await authorizeNoticeBranch({ ...input, writable: false });
    const rows = await prisma.whatsAppServiceNotice.findMany({
      where: { branchId: input.branchId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      include: {
        _count: {
          select: {
            messages: {
              where: {
                OR: [
                  { status: "SCHEDULED" },
                  { status: "CLAIMED", submissionStartedAt: null },
                ],
              },
            },
          },
        },
      },
    });
    return {
      notices: rows.map(row => serializeNotice(row, row._count.messages > 0)),
    };
  }

  static async reconcileStatusInTransaction(input: {
    tx: Prisma.TransactionClient;
    noticeId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const notice = await input.tx.whatsAppServiceNotice.findUnique({
      where: { id: assertId(input.noticeId) },
    });
    if (!notice) throw new WhatsAppResourceNotFoundError();
    const grouped = await input.tx.whatsAppMessage.groupBy({
      by: ["status"],
      where: { serviceNoticeId: notice.id },
      _count: { _all: true },
      orderBy: { status: "asc" },
    });
    const counts = new Map(grouped.map(row => [row.status, row._count._all]));
    const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
    if (total === 0) return notice;
    const count = (...statuses: Array<typeof grouped[number]["status"]>) =>
      statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
    const success = count("DELIVERED", "READ");
    const failed = count("FAILED");
    const withdrawn = count("CANCELLED", "SUPPRESSED");
    const unknown = count("UNKNOWN");
    const pending = total - success - failed - withdrawn - unknown;
    let status: WhatsAppServiceNoticeStatus = "QUEUED";
    let completedAt: Date | null = null;
    if (pending > 0) {
      status = notice.cancelledAt ? "PARTIAL" : "QUEUED";
    } else if (withdrawn === total) {
      status = "CANCELLED";
      completedAt = now;
    } else if (unknown > 0 || withdrawn > 0 || success > 0 && failed > 0) {
      status = "PARTIAL";
      completedAt = now;
    } else if (success === total) {
      status = "COMPLETED";
      completedAt = now;
    } else {
      status = notice.cancelledAt ? "CANCELLED" : "FAILED";
      completedAt = now;
    }
    if (notice.status === status && notice.completedAt?.getTime() === completedAt?.getTime()) {
      return notice;
    }
    return input.tx.whatsAppServiceNotice.update({
      where: { id: notice.id },
      data: { status, completedAt },
    });
  }

  static async cancel(input: {
    actorUserId: string;
    branchId: string;
    noticeId: string;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppServiceNoticesEnabled(input.env);
    const now = input.now ?? new Date();
    return prisma.$transaction(async tx => {
      await authorizeNoticeBranch({ ...input, client: tx, writable: true });
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "WhatsAppServiceNotice"
        WHERE "id" = ${assertId(input.noticeId)}
        FOR UPDATE
      `);
      const notice = await tx.whatsAppServiceNotice.findFirst({
        where: { id: input.noticeId, branchId: input.branchId },
      });
      if (!notice) throw new WhatsAppResourceNotFoundError();
      const cancellation = await WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
        tx,
        scope: {
          organizationId: notice.organizationId,
          branchId: notice.branchId,
          senderId: notice.senderId,
          serviceNoticeId: notice.id,
          purpose: "SERVICE_NOTICE",
        },
        reason: "SERVICE_NOTICE_CANCELLED",
        now,
      });
      if (!notice.cancelledAt && cancellation.cancelledCount > 0) {
        await tx.whatsAppServiceNotice.update({
          where: { id: notice.id },
          data: { cancelledAt: now },
        });
      }
      const reconciled = await this.reconcileStatusInTransaction({ tx, noticeId: notice.id, now });
      const remainingMessageCount = await tx.whatsAppMessage.count({
        where: {
          serviceNoticeId: notice.id,
          status: { notIn: ["CANCELLED", "SUPPRESSED"] },
        },
      });
      if (!notice.cancelledAt && cancellation.cancelledCount > 0) {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: notice.organizationId,
            branchId: notice.branchId,
            senderId: notice.senderId,
            actorUserId: input.actorUserId,
            action: "SERVICE_NOTICE_CANCELLED",
            details: {
              cancelledMessageCount: cancellation.cancelledCount,
              releasedReservationCount: cancellation.releasedReservationCount,
              remainingMessageCount,
            },
          },
        });
      }
      return {
        noticeId: notice.id,
        status: reconciled.status,
        queuedMessageCount: remainingMessageCount,
        suppressedCount: reconciled.suppressedCount,
      };
    }, { isolationLevel: "Serializable" });
  }

  static async cancelForSenderMutationInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    senderId: string;
    branchId?: string | null;
    reason: string;
    now?: Date;
  }) {
    assertId(input.organizationId);
    assertId(input.senderId);
    if (input.branchId) assertId(input.branchId);
    if (!/^[A-Z0-9_]{1,64}$/.test(input.reason)) throw new WhatsAppValidationError();
    const now = input.now ?? new Date();
    const scope = {
      organizationId: input.organizationId,
      senderId: input.senderId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      purpose: "SERVICE_NOTICE" as const,
    };
    const cancellation = await WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
      tx: input.tx,
      scope,
      reason: input.reason,
      now,
    });
    const noticeWhere: Prisma.WhatsAppServiceNoticeWhereInput = {
      organizationId: input.organizationId,
      senderId: input.senderId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      status: { in: ["QUEUED", "PARTIAL"] },
    };
    const cancelled = await input.tx.whatsAppServiceNotice.updateMany({
      where: {
        ...noticeWhere,
        messages: {
          none: { status: { notIn: ["CANCELLED", "SUPPRESSED"] } },
        },
      },
      data: { status: "CANCELLED", cancelledAt: now, completedAt: now },
    });
    const partial = await input.tx.whatsAppServiceNotice.updateMany({
      where: {
        ...noticeWhere,
        messages: {
          some: { status: { notIn: ["CANCELLED", "SUPPRESSED"] } },
        },
      },
      data: { status: "PARTIAL", cancelledAt: now, completedAt: null },
    });
    return {
      ...cancellation,
      cancelledNoticeCount: cancelled.count,
      partialNoticeCount: partial.count,
    };
  }
}
