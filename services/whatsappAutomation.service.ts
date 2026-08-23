import { Prisma, type WhatsAppAutomationStage } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertWhatsAppAutomationPlannerEnabled,
  assertWhatsAppDeliverySchemaAccessEnabled,
  assertWhatsAppIntegrationEnabled,
  assertWhatsAppMessageWritesEnabled,
} from "@/lib/whatsappFeature";
import {
  MAX_WHATSAPP_MONTHLY_BUDGET_MINOR,
  paiseToInrMicros,
  validateWhatsAppMonthlyBudgetMinor,
} from "@/lib/whatsappCost";
import { WhatsAppResourceNotFoundError, WhatsAppValidationError } from "@/lib/whatsappHttp";
import { parseWhatsAppSendTime, whatsappBudgetMonth } from "@/lib/whatsappSchedule";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import { WhatsAppRecipientService } from "@/services/whatsappRecipient.service";

export const WHATSAPP_AUTOMATION_STAGES = [
  "WELCOME",
  "FEE_DUE_MINUS_7",
  "FEE_DUE_MINUS_3",
  "FEE_DUE_MINUS_1",
  "FEE_DUE_TODAY",
  "PAST_DUE_PLUS_1",
  "PAST_DUE_PLUS_3",
  "PAST_DUE_PLUS_7",
  "PAYMENT_CONFIRMATION",
  "PAYMENT_CORRECTION",
] as const satisfies readonly WhatsAppAutomationStage[];

export const MAX_WHATSAPP_DAILY_AUTOMATIC_MESSAGES = 200;
export const MAX_WHATSAPP_COLLECTION_MESSAGES_PER_CYCLE = 4;
export const WHATSAPP_SETTINGS_LANGUAGES = ["en_IN", "hi"] as const;
export const WHATSAPP_SETTINGS_TONES = ["polite", "friendly", "firm"] as const;

type ManagedTemplateKey =
  | "WELCOME_GENERAL"
  | "WELCOME_ALLOCATED"
  | "FEE_RENEWAL_POLITE"
  | "FEE_RENEWAL_FRIENDLY"
  | "PAST_DUE_POLITE"
  | "PAST_DUE_FIRM"
  | "MULTI_STUDENT_COLLECTION_SUMMARY"
  | "PAYMENT_CONFIRMATION"
  | "PAYMENT_CORRECTION";

export function requiredManagedTemplateKeysForAutomation(input: {
  stages: readonly WhatsAppAutomationStage[];
  tone: string;
}) {
  const keys = new Set<ManagedTemplateKey>();
  for (const stage of input.stages) {
    if (stage === "WELCOME") {
      keys.add("WELCOME_GENERAL");
      keys.add("WELCOME_ALLOCATED");
    } else if (stage === "PAYMENT_CONFIRMATION") {
      keys.add("PAYMENT_CONFIRMATION");
    } else if (stage === "PAYMENT_CORRECTION") {
      keys.add("PAYMENT_CORRECTION");
    } else if (stage.startsWith("PAST_DUE")) {
      keys.add(input.tone === "firm" ? "PAST_DUE_FIRM" : "PAST_DUE_POLITE");
      keys.add("MULTI_STUDENT_COLLECTION_SUMMARY");
    } else {
      keys.add(input.tone === "friendly" ? "FEE_RENEWAL_FRIENDLY" : "FEE_RENEWAL_POLITE");
      keys.add("MULTI_STUDENT_COLLECTION_SUMMARY");
    }
  }
  return [...keys].sort();
}

function isGenericAuthorizationFailure(error: unknown) {
  return error instanceof Error
    && (error.message === "Branch not found" || error.message.startsWith("Unauthorized:"));
}

async function authorizeBranch(
  actorUserId: string,
  branchId: string,
  action: "view_whatsapp" | "manage_whatsapp",
  client: Prisma.TransactionClient | typeof prisma = prisma,
  writable = false
) {
  try {
    await StaffService.authorize(actorUserId, branchId, action, client);
  } catch (error) {
    if (isGenericAuthorizationFailure(error)) throw new WhatsAppResourceNotFoundError();
    throw error;
  }
  await EntitlementService.assertBranchEntitlement(
    branchId,
    "WHATSAPP_AUTOMATION",
    client
  );
  if (writable) await EntitlementService.assertBranchWritable(branchId, client);
}

function normalizeLanguage(language: string) {
  return language === "en" ? "en_IN" : language;
}

function groupedIdCount(row: { _count?: true | { id?: number } }) {
  return typeof row._count === "object" ? row._count.id ?? 0 : 0;
}

function assertSettingsInput(input: WhatsAppAutomationSettingsUpdate) {
  if (input.defaultLanguage !== undefined && !WHATSAPP_SETTINGS_LANGUAGES.includes(input.defaultLanguage)) {
    throw new WhatsAppValidationError("Unsupported WhatsApp language");
  }
  if (input.defaultTone !== undefined && !WHATSAPP_SETTINGS_TONES.includes(input.defaultTone)) {
    throw new WhatsAppValidationError("Unsupported WhatsApp tone");
  }
  if (input.sendTimeLocal !== undefined) parseWhatsAppSendTime(input.sendTimeLocal);
  if (
    input.dailyAutomaticMessageLimit !== undefined
    && (!Number.isSafeInteger(input.dailyAutomaticMessageLimit)
      || input.dailyAutomaticMessageLimit < 1
      || input.dailyAutomaticMessageLimit > MAX_WHATSAPP_DAILY_AUTOMATIC_MESSAGES)
  ) {
    throw new WhatsAppValidationError("Daily automatic limit is invalid");
  }
  if (
    input.maxAutomaticCollectionMessagesPerCycle !== undefined
    && (!Number.isSafeInteger(input.maxAutomaticCollectionMessagesPerCycle)
      || input.maxAutomaticCollectionMessagesPerCycle < 1
      || input.maxAutomaticCollectionMessagesPerCycle > MAX_WHATSAPP_COLLECTION_MESSAGES_PER_CYCLE)
  ) {
    throw new WhatsAppValidationError("Collection cycle limit is invalid");
  }
  if (input.monthlyBudgetMinor !== undefined && input.monthlyBudgetMinor !== null) {
    try {
      validateWhatsAppMonthlyBudgetMinor(input.monthlyBudgetMinor);
    } catch {
      throw new WhatsAppValidationError(
        `Monthly budget must be between 1 and ${MAX_WHATSAPP_MONTHLY_BUDGET_MINOR} paise`
      );
    }
  }
  if (input.rules) {
    const seen = new Set<string>();
    for (const rule of input.rules) {
      if (!WHATSAPP_AUTOMATION_STAGES.includes(rule.stage) || seen.has(rule.stage)) {
        throw new WhatsAppValidationError("Automation stages are invalid");
      }
      seen.add(rule.stage);
    }
  }
}

export function assertWhatsAppAutomaticLimitAuthority(input: {
  isOwner: boolean;
  currentDailyLimit: number;
  currentCycleLimit: number;
  nextDailyLimit?: number;
  nextCycleLimit?: number;
}) {
  if (input.isOwner) return;
  if (
    (input.nextDailyLimit !== undefined
      && input.nextDailyLimit > input.currentDailyLimit)
    || (input.nextCycleLimit !== undefined
      && input.nextCycleLimit > input.currentCycleLimit)
  ) {
    throw new WhatsAppValidationError(
      "Only the organization owner can increase automatic message limits"
    );
  }
}

export type WhatsAppAutomationSettingsUpdate = {
  defaultLanguage?: (typeof WHATSAPP_SETTINGS_LANGUAGES)[number];
  defaultTone?: (typeof WHATSAPP_SETTINGS_TONES)[number];
  sendTimeLocal?: string;
  dailyAutomaticMessageLimit?: number;
  maxAutomaticCollectionMessagesPerCycle?: number;
  monthlyBudgetMinor?: number | null;
  rules?: Array<{ stage: WhatsAppAutomationStage; enabled: boolean }>;
};

async function currentSettings(
  branchId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  const settings = await client.branchWhatsAppSettings.findUnique({
    where: { branchId },
    include: {
      branch: {
        select: {
          organizationId: true,
          organization: { select: { ownerId: true, timezone: true } },
        },
      },
      sender: {
        select: {
          id: true,
          status: true,
          providerMode: true,
          displayPhoneNumber: true,
          lastHealthCheckAt: true,
        },
      },
    },
  });
  if (!settings || settings.organizationId !== settings.branch.organizationId) {
    throw new WhatsAppResourceNotFoundError();
  }
  return settings;
}

async function resolveBranchOrganizationId(branchId: string) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { organizationId: true },
  });
  if (!branch) throw new WhatsAppResourceNotFoundError();
  return branch.organizationId;
}

async function lockBranchSettings(tx: Prisma.TransactionClient, branchId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "branchId"
    FROM "BranchWhatsAppSettings"
    WHERE "branchId" = ${branchId}
    FOR UPDATE
  `);
}

export class WhatsAppAutomationService {
  static async get(input: { actorUserId: string; branchId: string }) {
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppDeliverySchemaAccessEnabled();
    await authorizeBranch(input.actorUserId, input.branchId, "view_whatsapp");
    const settings = await currentSettings(input.branchId);
    const timeZone = settings.branch.organization.timezone;
    const now = new Date();
    const budgetMonth = whatsappBudgetMonth(now, timeZone);
    const recentHealthSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const senderId = settings.senderId ?? "";
    const [
      rules,
      budgetStates,
      activeStudents,
      missingPhones,
      recipientCounts,
      associatedStudents,
      optedInStudents,
      optedOutStudents,
      statusCounts,
      bindings,
      lastWebhookReceipt,
    ] =
      await prisma.$transaction([
        prisma.whatsAppAutomationRule.findMany({
          where: { branchId: input.branchId },
          orderBy: { stage: "asc" },
          select: { stage: true, enabled: true },
        }),
        prisma.whatsAppMessage.groupBy({
          by: ["budgetState"],
          where: {
            branchId: input.branchId,
            budgetMonth,
            budgetState: { in: ["RESERVED", "COMMITTED"] },
          },
          _sum: { estimatedCostMicros: true },
          orderBy: { budgetState: "asc" },
        }),
        prisma.student.count({ where: { branchId: input.branchId, status: "ACTIVE" } }),
        prisma.student.count({
          where: {
            branchId: input.branchId,
            status: "ACTIVE",
            OR: [{ phone: null }, { phone: "" }],
          },
        }),
        prisma.whatsAppStudentRecipient.groupBy({
          by: ["status"],
          where: {
            branchId: input.branchId,
            senderId,
            student: { status: "ACTIVE" },
          },
          _count: { id: true },
          orderBy: { status: "asc" },
        }),
        prisma.whatsAppStudentRecipient.count({
          where: { branchId: input.branchId, senderId, student: { status: "ACTIVE" } },
        }),
        prisma.whatsAppStudentRecipient.count({
          where: {
            branchId: input.branchId,
            senderId,
            status: "ACTIVE",
            student: { status: "ACTIVE" },
            consent: { consentType: "OPERATIONAL", status: "OPTED_IN" },
          },
        }),
        prisma.whatsAppStudentRecipient.count({
          where: {
            branchId: input.branchId,
            senderId,
            student: { status: "ACTIVE" },
            consent: { consentType: "OPERATIONAL", status: "OPTED_OUT" },
          },
        }),
        prisma.whatsAppMessage.groupBy({
          by: ["status"],
          where: { branchId: input.branchId, createdAt: { gte: recentHealthSince } },
          _count: { id: true },
          orderBy: { status: "asc" },
        }),
        prisma.whatsAppTemplateBinding.findMany({
          where: { senderId, language: normalizeLanguage(settings.defaultLanguage) },
          select: {
            managedKey: true,
            active: true,
            template: { select: { providerStatus: true, category: true, staleAt: true } },
          },
        }),
        prisma.whatsAppWebhookReceipt.findFirst({
          where: { senderId },
          orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
          select: { receivedAt: true },
        }),
      ]);

    const budgetMicros = settings.monthlyBudgetMinor == null
      ? null
      : paiseToInrMicros(settings.monthlyBudgetMinor);
    const reservedMicros = budgetStates.find(row => row.budgetState === "RESERVED")
      ?._sum?.estimatedCostMicros ?? 0n;
    const committedMicros = budgetStates.find(row => row.budgetState === "COMMITTED")
      ?._sum?.estimatedCostMicros ?? 0n;
    const usedMicros = reservedMicros + committedMicros;
    const remainingMicros = budgetMicros == null
      ? null
      : (() => {
          const remaining = BigInt(budgetMicros) - usedMicros;
          return remaining > 0n ? remaining : 0n;
        })();
    return {
      branchId: settings.branchId,
      enabled: settings.enabled,
      automationEnabled: settings.automationEnabledAt !== null,
      automationEnabledAt: settings.automationEnabledAt,
      defaultLanguage: normalizeLanguage(settings.defaultLanguage),
      defaultTone: settings.defaultTone,
      sendTimeLocal: settings.sendTimeLocal,
      dailyAutomaticMessageLimit: settings.dailyAutomaticMessageLimit,
      maxAutomaticCollectionMessagesPerCycle: settings.maxAutomaticCollectionMessagesPerCycle,
      configurationRevision: settings.configurationRevision,
      monthlyBudgetMinor: settings.monthlyBudgetMinor,
      timeZone,
      sender: settings.sender,
      rules,
      templateHealth: bindings,
      budget: {
        month: budgetMonth,
        ceilingMicros: budgetMicros?.toString() ?? null,
        reservedMicros: reservedMicros.toString(),
        committedMicros: committedMicros.toString(),
        reservedAndCommittedMicros: usedMicros.toString(),
        remainingMicros: remainingMicros?.toString() ?? null,
      },
      consentCoverage: {
        activeStudents,
        missingPhone: missingPhones,
        associated: associatedStudents,
        optedIn: optedInStudents,
        optedOut: optedOutStudents,
        stale: recipientCounts.find(row => row.status === "STALE")
          ? groupedIdCount(recipientCounts.find(row => row.status === "STALE")!)
          : 0,
        recipientStatusCounts: Object.fromEntries(
          recipientCounts.map(row => [row.status, groupedIdCount(row)])
        ),
      },
      deliveryHealth: Object.fromEntries(statusCounts.map(row => [row.status, groupedIdCount(row)])),
      deliveryHealthWindowDays: 30,
      lastWebhookReceivedAt: lastWebhookReceipt?.receivedAt ?? null,
      lastPlannedAt: settings.lastPlannedAt,
      lastPlannerErrorCode: settings.lastPlannerErrorCode,
    };
  }

  static async update(input: {
    actorUserId: string;
    branchId: string;
    changes: WhatsAppAutomationSettingsUpdate;
  }) {
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppDeliverySchemaAccessEnabled();
    assertSettingsInput(input.changes);
    await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", prisma, true);

    return prisma.$transaction(async tx => {
      await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", tx, true);
      await lockBranchSettings(tx, input.branchId);
      const settings = await currentSettings(input.branchId, tx);
      const isOwner = settings.branch.organization.ownerId === input.actorUserId;
      assertWhatsAppAutomaticLimitAuthority({
        isOwner,
        currentDailyLimit: settings.dailyAutomaticMessageLimit,
        currentCycleLimit: settings.maxAutomaticCollectionMessagesPerCycle,
        nextDailyLimit: input.changes.dailyAutomaticMessageLimit,
        nextCycleLimit: input.changes.maxAutomaticCollectionMessagesPerCycle,
      });
      const nextBudget = input.changes.monthlyBudgetMinor;
      if (
        nextBudget !== undefined
        && !isOwner
        && nextBudget !== null
        && (settings.monthlyBudgetMinor === null || nextBudget > settings.monthlyBudgetMinor)
      ) {
        throw new WhatsAppValidationError("Only the organization owner can increase the budget");
      }
      if (settings.enabled && nextBudget === null) {
        throw new WhatsAppValidationError("Disable branch delivery before removing its budget");
      }

      const rules = input.changes.rules ?? [];
      const storedRules = await tx.whatsAppAutomationRule.findMany({
        where: { branchId: input.branchId },
        select: { stage: true, enabled: true },
      });
      const desiredRuleState = new Map<WhatsAppAutomationStage, boolean>(
        storedRules.map(rule => [rule.stage, rule.enabled])
      );
      for (const rule of rules) desiredRuleState.set(rule.stage, rule.enabled);
      const language = normalizeLanguage(input.changes.defaultLanguage ?? settings.defaultLanguage);
      const tone = input.changes.defaultTone ?? settings.defaultTone;
      const enabledStages = [...desiredRuleState]
        .filter(([, enabled]) => enabled)
        .map(([stage]) => stage);
      if (enabledStages.length > 0 && !settings.senderId) {
        throw new WhatsAppValidationError("An active sender must be assigned first");
      }
      if (enabledStages.length > 0) {
        const requiredKeys = requiredManagedTemplateKeysForAutomation({ stages: enabledStages, tone });
        const activeBindings = await tx.whatsAppTemplateBinding.count({
          where: {
            senderId: settings.senderId!,
            language,
            managedKey: { in: requiredKeys },
            active: true,
            template: { providerStatus: "APPROVED", category: "UTILITY", staleAt: null },
          },
        });
        if (activeBindings !== requiredKeys.length) {
          throw new WhatsAppValidationError("Required approved Utility templates are unavailable");
        }
      }

      await tx.branchWhatsAppSettings.update({
        where: { branchId: input.branchId },
        data: {
          ...(input.changes.defaultLanguage !== undefined ? { defaultLanguage: language } : {}),
          ...(input.changes.defaultTone !== undefined ? { defaultTone: input.changes.defaultTone } : {}),
          ...(input.changes.sendTimeLocal !== undefined ? { sendTimeLocal: input.changes.sendTimeLocal } : {}),
          ...(input.changes.dailyAutomaticMessageLimit !== undefined
            ? { dailyAutomaticMessageLimit: input.changes.dailyAutomaticMessageLimit }
            : {}),
          ...(input.changes.maxAutomaticCollectionMessagesPerCycle !== undefined
            ? { maxAutomaticCollectionMessagesPerCycle: input.changes.maxAutomaticCollectionMessagesPerCycle }
            : {}),
          ...(input.changes.monthlyBudgetMinor !== undefined
            ? { monthlyBudgetMinor: input.changes.monthlyBudgetMinor }
            : {}),
          configurationRevision: { increment: 1 },
        },
      });

      for (const rule of rules) {
        await tx.whatsAppAutomationRule.upsert({
          where: { branchId_stage: { branchId: input.branchId, stage: rule.stage } },
          create: {
            organizationId: settings.organizationId,
            branchId: input.branchId,
            stage: rule.stage,
            enabled: rule.enabled,
          },
          update: { enabled: rule.enabled },
        });
        if (!rule.enabled) {
          await WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
            tx,
            scope: { branchId: input.branchId, trigger: "AUTOMATION", automationStage: rule.stage },
            reason: "AUTOMATION_STAGE_DISABLED",
          });
        }
      }

      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: settings.organizationId,
          branchId: input.branchId,
          senderId: settings.senderId,
          actorUserId: input.actorUserId,
          action: "AUTOMATION_SETTINGS_CHANGED",
          details: {
            changedFields: Object.keys(input.changes).sort().slice(0, 16),
            enabledStageCount: enabledStages.length,
          },
        },
      });
      return { updated: true as const };
    });
  }

  static async enableDelivery(input: { actorUserId: string; branchId: string }) {
    assertWhatsAppIntegrationEnabled();
    await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", prisma, true);
    assertWhatsAppMessageWritesEnabled(await resolveBranchOrganizationId(input.branchId));
    return prisma.$transaction(async tx => {
      await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", tx, true);
      await lockBranchSettings(tx, input.branchId);
      const settings = await currentSettings(input.branchId, tx);
      if (!settings.senderId || settings.sender?.status !== "ACTIVE") {
        throw new WhatsAppValidationError("An active sender must be assigned first");
      }
      validateWhatsAppMonthlyBudgetMinor(settings.monthlyBudgetMinor);
      const requiredKeys = requiredManagedTemplateKeysForAutomation({
        stages: ["FEE_DUE_TODAY"],
        tone: settings.defaultTone,
      });
      const activeBindings = await tx.whatsAppTemplateBinding.count({
        where: {
          senderId: settings.senderId,
          language: normalizeLanguage(settings.defaultLanguage),
          managedKey: { in: requiredKeys },
          active: true,
          template: { providerStatus: "APPROVED", category: "UTILITY", staleAt: null },
        },
      });
      if (activeBindings !== requiredKeys.length) {
        throw new WhatsAppValidationError("Required approved Utility templates are unavailable");
      }
      await tx.branchWhatsAppSettings.update({
        where: { branchId: input.branchId },
        data: { enabled: true, configurationRevision: { increment: 1 } },
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: settings.organizationId,
          branchId: input.branchId,
          senderId: settings.senderId,
          actorUserId: input.actorUserId,
          action: "BRANCH_DELIVERY_ENABLED",
        },
      });
      return { enabled: true as const };
    });
  }

  static async disableDelivery(input: { actorUserId: string; branchId: string }) {
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppDeliverySchemaAccessEnabled();
    await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", prisma, true);
    return prisma.$transaction(async tx => {
      await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", tx, true);
      await lockBranchSettings(tx, input.branchId);
      const settings = await currentSettings(input.branchId, tx);
      await tx.branchWhatsAppSettings.update({
        where: { branchId: input.branchId },
        data: {
          enabled: false,
          automationEnabledAt: null,
          automationEnabledByUserId: null,
          configurationRevision: { increment: 1 },
        },
      });
      const cancellation = await WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
        tx,
        scope: { branchId: input.branchId },
        reason: "BRANCH_DISABLED",
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: settings.organizationId,
          branchId: input.branchId,
          senderId: settings.senderId,
          actorUserId: input.actorUserId,
          action: "BRANCH_DELIVERY_DISABLED",
          details: {
            cancelledMessageCount: cancellation.cancelledCount,
            releasedReservationCount: cancellation.releasedReservationCount,
          },
        },
      });
      return { enabled: false as const };
    });
  }

  static async enableAutomation(input: {
    actorUserId: string;
    branchId: string;
    confirmChargesAndProspectiveAutomation: boolean;
  }) {
    if (input.confirmChargesAndProspectiveAutomation !== true) {
      throw new WhatsAppValidationError("Explicit automation confirmation is required");
    }
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppAutomationPlannerEnabled();
    await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", prisma, true);
    assertWhatsAppMessageWritesEnabled(await resolveBranchOrganizationId(input.branchId));
    return prisma.$transaction(async tx => {
      await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", tx, true);
      await lockBranchSettings(tx, input.branchId);
      const settings = await currentSettings(input.branchId, tx);
      if (!settings.enabled || !settings.senderId || settings.sender?.status !== "ACTIVE") {
        throw new WhatsAppValidationError("Branch delivery and an active sender are required");
      }
      validateWhatsAppMonthlyBudgetMinor(settings.monthlyBudgetMinor);
      parseWhatsAppSendTime(settings.sendTimeLocal);
      const enabledRules = await tx.whatsAppAutomationRule.findMany({
        where: { branchId: input.branchId, enabled: true },
        select: { stage: true },
      });
      if (enabledRules.length === 0) {
        throw new WhatsAppValidationError("Select at least one automation stage");
      }
      const requiredKeys = requiredManagedTemplateKeysForAutomation({
        stages: enabledRules.map(rule => rule.stage),
        tone: settings.defaultTone,
      });
      const bindings = await tx.whatsAppTemplateBinding.count({
        where: {
          senderId: settings.senderId,
          language: normalizeLanguage(settings.defaultLanguage),
          managedKey: { in: requiredKeys },
          active: true,
          template: { providerStatus: "APPROVED", category: "UTILITY", staleAt: null },
        },
      });
      if (bindings !== requiredKeys.length) {
        throw new WhatsAppValidationError("Required approved Utility templates are unavailable");
      }
      const activeRecipients = await tx.whatsAppStudentRecipient.count({
        where: {
          branchId: input.branchId,
          senderId: settings.senderId,
          status: "ACTIVE",
          consent: { consentType: "OPERATIONAL", status: "OPTED_IN" },
        },
      });
      if (activeRecipients === 0) {
        throw new WhatsAppValidationError("Record operational consent before enabling automation");
      }
      const now = new Date();
      await tx.branchWhatsAppSettings.update({
        where: { branchId: input.branchId },
        data: {
          automationEnabledAt: now,
          automationEnabledByUserId: input.actorUserId,
          configurationRevision: { increment: 1 },
        },
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: settings.organizationId,
          branchId: input.branchId,
          senderId: settings.senderId,
          actorUserId: input.actorUserId,
          action: "AUTOMATION_ENABLED",
          details: { enabledStageCount: enabledRules.length, prospectiveFrom: now.toISOString() },
        },
      });
      return { enabled: true as const, prospectiveFrom: now };
    });
  }

  static async disableAutomation(input: { actorUserId: string; branchId: string }) {
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppDeliverySchemaAccessEnabled();
    await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", prisma, true);
    return prisma.$transaction(async tx => {
      await authorizeBranch(input.actorUserId, input.branchId, "manage_whatsapp", tx, true);
      await lockBranchSettings(tx, input.branchId);
      const settings = await currentSettings(input.branchId, tx);
      await tx.branchWhatsAppSettings.update({
        where: { branchId: input.branchId },
        data: {
          automationEnabledAt: null,
          automationEnabledByUserId: null,
          configurationRevision: { increment: 1 },
        },
      });
      await WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
        tx,
        scope: { branchId: input.branchId, trigger: "AUTOMATION" },
        reason: "AUTOMATION_DISABLED",
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: settings.organizationId,
          branchId: input.branchId,
          senderId: settings.senderId,
          actorUserId: input.actorUserId,
          action: "AUTOMATION_DISABLED",
        },
      });
      return { enabled: false as const };
    });
  }
}
