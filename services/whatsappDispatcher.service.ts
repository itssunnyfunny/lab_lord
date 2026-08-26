import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getMetaWhatsAppClient,
  META_GRAPH_MAX_TIMEOUT_MS,
  MetaWhatsAppAmbiguousMutationError,
  MetaWhatsAppInputError,
  MetaWhatsAppProviderError,
  type MetaWhatsAppProviderClient,
} from "@/lib/metaWhatsApp";
import {
  areWhatsAppMessageWritesEnabled,
  configuredWhatsAppLiveDeliveryCanaryOrganizationIds,
  isWhatsAppIntegrationEnabled,
  isWhatsAppLiveAutomationOrganizationEnabled,
  isWhatsAppServiceNoticesEnabled,
  resolveWhatsAppProviderMode,
  WHATSAPP_META_MESSAGE_WRITES_FLAG,
} from "@/lib/whatsappFeature";
import {
  getWhatsAppRateCardStatus,
  paiseToInrMicros,
  readWhatsAppRateCard,
  resolveWhatsAppUtilityRate,
  validateWhatsAppMonthlyBudgetMinor,
} from "@/lib/whatsappCost";
import {
  getManagedWhatsAppTemplate,
  managedProviderTemplateMatches,
  prepareManagedWhatsAppTemplate,
  type WhatsAppManagedTemplateKey,
  type WhatsAppManagedTemplateLanguage,
} from "@/lib/whatsappManagedTemplates";
import { projectWhatsAppStatus } from "@/lib/whatsappMessageState";
import { normalizeWhatsAppPhone } from "@/lib/whatsappPhone";
import { whatsappBudgetMonth } from "@/lib/whatsappSchedule";
import { lockWhatsAppProviderMessage } from "@/lib/whatsappProviderMessageLock";
import { EntitlementService } from "@/services/entitlement.service";
import {
  createWhatsAppManualSourceFingerprint,
  deriveWhatsAppManualCollectionContent,
} from "@/services/whatsappMessage.service";
import { verifyAutomaticMessageSource } from "@/services/whatsappPlanner.service";
import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";
import { verifyWhatsAppReportMessageSource } from "@/services/whatsappReport.service";
import { WhatsAppSenderSafetyService } from "@/services/whatsappSenderSafety.service";
import {
  verifyWhatsAppServiceNoticeSource,
  WhatsAppServiceNoticeService,
} from "@/services/whatsappServiceNotice.service";
import { WhatsAppJobRunService } from "@/services/whatsappJobRun.service";

export const MAX_WHATSAPP_DISPATCH_BATCH = 50;
export const DEFAULT_WHATSAPP_DISPATCH_BATCH = 20;
export const MAX_WHATSAPP_DISPATCH_ATTEMPTS = 3;
export const WHATSAPP_DISPATCH_LEASE_MS = 2 * 60_000;
const WHATSAPP_DISPATCH_PROVIDER_LEASE_SAFETY_MS = 30_000;
export const WHATSAPP_DISPATCH_PROVIDER_LEASE_MS = Math.max(
  WHATSAPP_DISPATCH_LEASE_MS,
  META_GRAPH_MAX_TIMEOUT_MS + WHATSAPP_DISPATCH_PROVIDER_LEASE_SAFETY_MS
);

type DispatchErrorDisposition = "RATE_LIMIT" | "DEFINITE" | "AMBIGUOUS";
type DispatchClock = () => Date;

export function createWhatsAppDispatchOperationClock(input: {
  now?: Date;
  clock?: DispatchClock;
} = {}): DispatchClock {
  const source = input.clock ?? (input.now
    ? () => input.now!
    : () => new Date());
  return () => {
    const value = source();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("WhatsApp dispatcher clock is invalid");
    }
    return new Date(value.getTime());
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function flagEnabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

export function classifyWhatsAppDispatchError(error: unknown): DispatchErrorDisposition {
  if (error instanceof MetaWhatsAppAmbiguousMutationError) return "AMBIGUOUS";
  if (error instanceof MetaWhatsAppInputError) return "DEFINITE";
  if (error instanceof MetaWhatsAppProviderError) {
    if (error.kind === "RATE_LIMIT") return "RATE_LIMIT";
    if (["AUTHENTICATION", "NOT_FOUND", "REQUEST"].includes(error.kind)) return "DEFINITE";
    return "AMBIGUOUS";
  }
  return "AMBIGUOUS";
}

export function calculateWhatsAppRetryAt(input: {
  now: Date;
  attemptCount: number;
  retryAfterSeconds?: number | null;
}) {
  const providerDelay = input.retryAfterSeconds;
  const seconds = providerDelay !== null
    && providerDelay !== undefined
    && Number.isSafeInteger(providerDelay)
    && providerDelay >= 0
    ? Math.min(providerDelay, 15 * 60)
    : Math.min(15 * 60, 30 * 2 ** Math.max(0, input.attemptCount - 1));
  return new Date(input.now.getTime() + Math.max(1, seconds) * 1_000);
}

function normalizeLanguage(value: string): WhatsAppManagedTemplateLanguage | null {
  if (value === "en") return "en_IN";
  return value === "en_IN" || value === "hi" ? value : null;
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function suppressClaimedMessage(input: {
  tx: Prisma.TransactionClient;
  messageId: string;
  senderId: string;
  leaseToken: string;
  code: string;
  now: Date;
  releaseReservedBudget: boolean;
}) {
  const result = await input.tx.whatsAppMessage.updateMany({
    where: {
      id: input.messageId,
      leaseToken: input.leaseToken,
      status: "CLAIMED",
      submissionStartedAt: null,
    },
    data: {
      status: "SUPPRESSED",
      suppressedAt: input.now,
      failureCode: input.code,
      ...(input.releaseReservedBudget ? { budgetState: "RELEASED" as const } : {}),
      leaseToken: null,
      leaseUntil: null,
    },
  });
  if (result.count === 1) {
    await input.tx.whatsAppMessageEvent.create({
      data: {
        messageId: input.messageId,
        senderId: input.senderId,
        // A pre-provider SYSTEM event truthfully has no Meta message ID.
        providerMessageId: null,
        eventKey: sha256(JSON.stringify({
          kind: "send-time-suppression-v1",
          messageId: input.messageId,
          code: input.code,
        })),
        source: "SYSTEM",
        status: "SUPPRESSED",
        receivedAt: input.now,
        payloadHash: sha256(JSON.stringify({ code: input.code })),
        safeErrorCode: input.code,
      },
    });
  }
  return result.count === 1;
}

async function holdClaimedMessage(input: {
  tx: Prisma.TransactionClient;
  messageId: string;
  leaseToken: string;
}) {
  const result = await input.tx.whatsAppMessage.updateMany({
    where: {
      id: input.messageId,
      leaseToken: input.leaseToken,
      status: "CLAIMED",
      submissionStartedAt: null,
    },
    data: {
      status: "SCHEDULED",
      claimedAt: null,
      leaseToken: null,
      leaseUntil: null,
    },
  });
  return result.count === 1;
}

async function releaseClaim(input: {
  messageId: string;
  leaseToken: string;
  availableAt?: Date;
}) {
  await prisma.whatsAppMessage.updateMany({
    where: { id: input.messageId, leaseToken: input.leaseToken, status: "CLAIMED" },
    data: {
      status: "SCHEDULED",
      leaseToken: null,
      leaseUntil: null,
      claimedAt: null,
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    },
  });
}

export function resolveWhatsAppDispatchOrganizationScope(
  env: Readonly<Record<string, string | undefined>>
) {
  return resolveWhatsAppProviderMode(env) === "TEST"
    ? null
    : [...configuredWhatsAppLiveDeliveryCanaryOrganizationIds(env)].sort();
}

async function claimMessages(
  now: Date,
  limit: number,
  organizationIds: readonly string[] | null,
  providerMode: "TEST" | "LIVE"
) {
  return prisma.$transaction(async tx => {
    const scheduledOrganizationFilter = organizationIds === null
      ? Prisma.sql``
      : organizationIds.length === 0
        ? Prisma.sql`AND FALSE`
        : Prisma.sql`AND "organizationId" IN (${Prisma.join(organizationIds)})`;
    const staleSubmittingRows = await tx.$queryRaw<Array<{
      id: string;
      organizationId: string;
      branchId: string | null;
      senderId: string;
      providerCallAdmittedAt: Date | null;
    }>>(Prisma.sql`
      SELECT "id", "organizationId", "branchId", "senderId", "providerCallAdmittedAt"
      FROM "WhatsAppMessage"
      WHERE "status" = 'SUBMITTING'::"WhatsAppMessageStatus"
        AND "leaseUntil" < ${now}
        AND EXISTS (
          SELECT 1
          FROM "WhatsAppSender" AS sender
          WHERE sender."id" = "WhatsAppMessage"."senderId"
            AND sender."providerMode" = ${providerMode}::"WhatsAppProviderMode"
        )
      ORDER BY "leaseUntil" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `);
    let staleSubmittingCount = 0;
    let stalePreSubmissionRecovered = 0;
    for (const row of staleSubmittingRows) {
      if (!row.providerCallAdmittedAt) {
        const recovered = await tx.whatsAppMessage.updateMany({
          where: {
            id: row.id,
            status: "SUBMITTING",
            providerCallAdmittedAt: null,
            leaseUntil: { lt: now },
          },
          data: {
            status: "SCHEDULED",
            claimedAt: null,
            submissionStartedAt: null,
            leaseToken: null,
            leaseUntil: null,
          },
        });
        stalePreSubmissionRecovered += recovered.count;
        continue;
      }
      const staleSubmitting = await tx.whatsAppMessage.updateMany({
          where: {
            id: row.id,
            status: "SUBMITTING",
            providerCallAdmittedAt: { not: null },
            leaseUntil: { lt: now },
          },
          data: {
            status: "UNKNOWN",
            failureCode: "PROVIDER_UNKNOWN_OUTCOME",
            budgetState: "COMMITTED",
            leaseToken: null,
            leaseUntil: null,
          },
        });
      if (staleSubmitting.count !== 1) continue;
      staleSubmittingCount += 1;
      await WhatsAppSenderSafetyService.recordAmbiguousOutcomeInTransaction({
        tx,
        organizationId: row.organizationId,
        branchId: row.branchId,
        senderId: row.senderId,
        messageId: row.id,
        now,
      });
      await WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
        tx,
        organizationId: row.organizationId,
        senderId: row.senderId,
        now,
      });
    }
    const staleClaimedRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "WhatsAppMessage"
      WHERE "status" = 'CLAIMED'::"WhatsAppMessageStatus"
        AND "submissionStartedAt" IS NULL
        AND "leaseUntil" < ${now}
        AND EXISTS (
          SELECT 1
          FROM "WhatsAppSender" AS sender
          WHERE sender."id" = "WhatsAppMessage"."senderId"
            AND sender."providerMode" = ${providerMode}::"WhatsAppProviderMode"
        )
      ORDER BY "leaseUntil" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `);
    const staleClaimed = staleClaimedRows.length === 0
      ? { count: 0 }
      : await tx.whatsAppMessage.updateMany({
          where: {
            id: { in: staleClaimedRows.map(row => row.id) },
            status: "CLAIMED",
            submissionStartedAt: null,
            leaseUntil: { lt: now },
          },
          data: {
            status: "SCHEDULED",
            claimedAt: null,
            leaseToken: null,
            leaseUntil: null,
          },
        });

    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH ranked AS (
        SELECT
          "id",
          "scheduledFor",
          ROW_NUMBER() OVER (
            PARTITION BY "organizationId", COALESCE("branchId", '__ORGANIZATION__')
            ORDER BY "scheduledFor" ASC, "id" ASC
          ) AS branch_rank
        FROM "WhatsAppMessage"
        WHERE "status" = 'SCHEDULED'::"WhatsAppMessageStatus"
          AND "availableAt" <= ${now}
          AND "scheduledFor" <= ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM "WhatsAppSenderSafetyState" AS safety
            WHERE safety."senderId" = "WhatsAppMessage"."senderId"
              AND (
                safety."pausedAt" IS NOT NULL
                OR safety."pauseRequestedAt" IS NOT NULL
              )
          )
          AND EXISTS (
            SELECT 1
            FROM "WhatsAppSender" AS sender
            WHERE sender."id" = "WhatsAppMessage"."senderId"
              AND sender."providerMode" = ${providerMode}::"WhatsAppProviderMode"
          )
          ${scheduledOrganizationFilter}
      )
      SELECT message."id"
      FROM "WhatsAppMessage" AS message
      INNER JOIN ranked ON ranked."id" = message."id"
      WHERE ranked.branch_rank <= 2
      ORDER BY ranked."scheduledFor" ASC, message."id" ASC
      FOR UPDATE OF message SKIP LOCKED
      LIMIT ${limit}
    `);
    const claimed: Array<{ id: string; organizationId: string; leaseToken: string }> = [];
    for (const row of rows) {
      const leaseToken = randomUUID();
      const updated = await tx.whatsAppMessage.updateMany({
        where: { id: row.id, status: "SCHEDULED", availableAt: { lte: now } },
        data: {
          status: "CLAIMED",
          claimedAt: now,
          leaseToken,
          leaseUntil: new Date(now.getTime() + WHATSAPP_DISPATCH_LEASE_MS),
        },
      });
      if (updated.count === 1) {
        const message = await tx.whatsAppMessage.findUnique({
          where: { id: row.id },
          select: { organizationId: true },
        });
        if (message) claimed.push({ id: row.id, organizationId: message.organizationId, leaseToken });
      }
    }
    return {
      claimed,
      staleClaimed: staleClaimed.count + stalePreSubmissionRecovered,
      staleSubmitting: staleSubmittingCount,
    };
  });
}

export type PreparedWhatsAppSubmission = {
  messageId: string;
  leaseToken: string;
  organizationId: string;
  branchId: string | null;
  senderId: string;
  serviceNoticeId: string | null;
  phoneNumberId: string;
  recipientPhoneE164: string;
  definition: ReturnType<typeof getManagedWhatsAppTemplate>;
  values: Record<string, unknown>;
  attemptCount: number;
  previousAttemptCount: number;
  previousLastAttemptAt: Date | null;
};

export type WhatsAppPreparedSubmissionPauseGuardResult = "READY" | "HELD" | "STALE";

type PreparedSubmissionRestoration = Readonly<{
  messageId: string;
  senderId: string;
  leaseToken: string;
}>;

function preparedSubmissionRestorationArgs(
  input: PreparedSubmissionRestoration
): Prisma.WhatsAppMessageUpdateManyArgs {
  return {
    where: {
      id: input.messageId,
      senderId: input.senderId,
      leaseToken: input.leaseToken,
      status: "SUBMITTING",
      providerMessageId: null,
      providerCallAdmittedAt: null,
    },
    data: {
      status: "SCHEDULED",
      claimedAt: null,
      submissionStartedAt: null,
      providerCallAdmittedAt: null,
      leaseToken: null,
      leaseUntil: null,
    },
  };
}

async function restorePreparedWhatsAppSubmissionInTransaction(input: {
  tx: Prisma.TransactionClient;
} & PreparedSubmissionRestoration) {
  const restored = await input.tx.whatsAppMessage.updateMany(
    preparedSubmissionRestorationArgs(input)
  );
  return restored.count === 1 ? "HELD" as const : "STALE" as const;
}

export async function restorePreparedWhatsAppSubmissionAfterAdmissionErrorInTransaction(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  messageId: string;
  senderId: string;
  leaseToken: string;
  admittedAt: Date;
  attemptCount: number;
  previousAttemptCount: number;
  previousLastAttemptAt: Date | null;
  now: Date;
}): Promise<Exclude<WhatsAppPreparedSubmissionPauseGuardResult, "READY">> {
  const lockedMessage = await input.tx.$queryRaw<Array<{
    id: string;
    providerCallAdmittedAt: Date | null;
  }>>(Prisma.sql`
    SELECT "id", "providerCallAdmittedAt"
    FROM "WhatsAppMessage"
    WHERE "id" = ${input.messageId}
      AND "senderId" = ${input.senderId}
      AND "leaseToken" = ${input.leaseToken}
      AND "status" = 'SUBMITTING'::"WhatsAppMessageStatus"
      AND "providerMessageId" IS NULL
      AND (
        (
          "providerCallAdmittedAt" IS NULL
          AND "attemptCount" = ${input.previousAttemptCount}
          AND "lastAttemptAt" IS NOT DISTINCT FROM ${input.previousLastAttemptAt}
        )
        OR (
          "providerCallAdmittedAt" = ${input.admittedAt}
          AND "attemptCount" = ${input.attemptCount}
          AND "lastAttemptAt" = ${input.admittedAt}
        )
      )
    FOR UPDATE
  `);
  const message = lockedMessage[0];
  if (!message) return "STALE";

  const lockedSafety = await input.tx.$queryRaw<Array<{ senderId: string }>>(Prisma.sql`
    SELECT "senderId"
    FROM "WhatsAppSenderSafetyState"
    WHERE "senderId" = ${input.senderId}
    FOR UPDATE
  `);
  if (lockedSafety.length !== 1) return "STALE";

  const admissionCommitted = message.providerCallAdmittedAt !== null;
  const restored = await input.tx.whatsAppMessage.updateMany({
    where: {
      id: input.messageId,
      senderId: input.senderId,
      leaseToken: input.leaseToken,
      status: "SUBMITTING",
      providerMessageId: null,
      providerCallAdmittedAt: admissionCommitted ? input.admittedAt : null,
      attemptCount: admissionCommitted ? input.attemptCount : input.previousAttemptCount,
      lastAttemptAt: admissionCommitted ? input.admittedAt : input.previousLastAttemptAt,
    },
    data: {
      status: "SCHEDULED",
      claimedAt: null,
      submissionStartedAt: null,
      providerCallAdmittedAt: null,
      attemptCount: input.previousAttemptCount,
      lastAttemptAt: input.previousLastAttemptAt,
      leaseToken: null,
      leaseUntil: null,
    },
  });
  if (restored.count !== 1) return "STALE";

  await WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
    tx: input.tx,
    organizationId: input.organizationId,
    senderId: input.senderId,
    now: input.now,
  });
  return "HELD";
}

export async function guardPreparedWhatsAppSubmissionAgainstPauseInTransaction(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  messageId: string;
  senderId: string;
  leaseToken: string;
  admittedAt: Date;
}): Promise<WhatsAppPreparedSubmissionPauseGuardResult> {
  const lockedMessage = await input.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "WhatsAppMessage"
    WHERE "id" = ${input.messageId}
      AND "senderId" = ${input.senderId}
      AND "leaseToken" = ${input.leaseToken}
      AND "status" = 'SUBMITTING'::"WhatsAppMessageStatus"
      AND "providerMessageId" IS NULL
      AND "providerCallAdmittedAt" IS NULL
    FOR UPDATE
  `);
  if (lockedMessage.length !== 1) return "STALE";
  const lockedSafety = await input.tx.$queryRaw<Array<{ senderId: string }>>(Prisma.sql`
    SELECT "senderId"
    FROM "WhatsAppSenderSafetyState"
    WHERE "senderId" = ${input.senderId}
    FOR UPDATE
  `);
  if (lockedSafety.length !== 1) return "STALE";
  const safetyState = await input.tx.whatsAppSenderSafetyState.findUnique({
    where: { senderId: input.senderId },
    select: { pausedAt: true, pauseRequestedAt: true },
  });
  if (!safetyState) return "STALE";
  if (safetyState.pausedAt || safetyState.pauseRequestedAt) {
    const restored = await restorePreparedWhatsAppSubmissionInTransaction({
      tx: input.tx,
      messageId: input.messageId,
      senderId: input.senderId,
      leaseToken: input.leaseToken,
    });
    if (restored === "HELD" && safetyState.pauseRequestedAt) {
      await WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
        tx: input.tx,
        organizationId: input.organizationId,
        senderId: input.senderId,
        now: input.admittedAt,
      });
    }
    return restored;
  }
  const admitted = await input.tx.whatsAppMessage.updateMany({
    where: {
      id: input.messageId,
      senderId: input.senderId,
      leaseToken: input.leaseToken,
      status: "SUBMITTING",
      providerMessageId: null,
      providerCallAdmittedAt: null,
    },
    data: {
      providerCallAdmittedAt: input.admittedAt,
      lastAttemptAt: input.admittedAt,
      attemptCount: { increment: 1 },
    },
  });
  return admitted.count === 1 ? "READY" : "STALE";
}

async function admitPreparedWhatsAppSubmission(input: {
  submission: PreparedWhatsAppSubmission;
  admittedAt: Date;
  clock: DispatchClock;
}): Promise<WhatsAppPreparedSubmissionPauseGuardResult> {
  try {
    return await prisma.$transaction(tx =>
      guardPreparedWhatsAppSubmissionAgainstPauseInTransaction({
          tx,
          organizationId: input.submission.organizationId,
          messageId: input.submission.messageId,
          senderId: input.submission.senderId,
          leaseToken: input.submission.leaseToken,
          admittedAt: input.admittedAt,
        })
    );
  } catch (error) {
    try {
      await prisma.$transaction(tx =>
        restorePreparedWhatsAppSubmissionAfterAdmissionErrorInTransaction({
          tx,
          organizationId: input.submission.organizationId,
          messageId: input.submission.messageId,
          senderId: input.submission.senderId,
          leaseToken: input.submission.leaseToken,
          admittedAt: input.admittedAt,
          attemptCount: input.submission.attemptCount,
          previousAttemptCount: input.submission.previousAttemptCount,
          previousLastAttemptAt: input.submission.previousLastAttemptAt,
          now: input.clock(),
        }),
      { isolationLevel: "ReadCommitted" });
    } catch {
      // If restoration cannot be proved, stale recovery uses the durable
      // admission marker to distinguish an unsent row from an ambiguous call.
    }
    throw error;
  }
}

async function prepareSubmission(input: {
  messageId: string;
  leaseToken: string;
  clock: DispatchClock;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<
  | { kind: "READY"; submission: PreparedWhatsAppSubmission }
  | { kind: "SUPPRESSED"; code: string }
  | { kind: "HELD"; code: string }
  | { kind: "STALE" }
> {
  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "WhatsAppMessage"
      WHERE "id" = ${input.messageId}
      FOR UPDATE
    `);
    if (locked.length !== 1) return { kind: "STALE" as const };
    const validationNow = input.clock();
    const message = await tx.whatsAppMessage.findFirst({
      where: { id: input.messageId, leaseToken: input.leaseToken, status: "CLAIMED" },
      include: {
        organization: true,
        branch: { include: { organization: true } },
        sender: { include: { safetyState: true } },
        student: true,
        paymentResolutionEvent: { include: { payment: true } },
        paymentSources: { include: { payment: { include: { student: true } } } },
        templateBinding: { include: { template: true, provisioning: true } },
      },
    });
    if (!message) return { kind: "STALE" as const };

    const suppress = async (code: string) => {
      const changed = await suppressClaimedMessage({
        tx,
        messageId: message.id,
        senderId: message.senderId,
        leaseToken: input.leaseToken,
        code,
        now: validationNow,
        releaseReservedBudget: message.budgetState === "RESERVED",
      });
      if (changed && message.serviceNoticeId) {
        await WhatsAppServiceNoticeService.reconcileStatusInTransaction({
          tx,
          noticeId: message.serviceNoticeId,
          now: validationNow,
        });
      }
      return { kind: "SUPPRESSED" as const, code };
    };
    const hold = async (code: string) => {
      await holdClaimedMessage({
        tx,
        messageId: message.id,
        leaseToken: input.leaseToken,
      });
      return { kind: "HELD" as const, code };
    };
    const isBranchReport = message.purpose === "DAILY_BRANCH_REPORT";
    const isOrganizationReport = message.purpose === "DAILY_ORGANIZATION_REPORT";
    const isReport = isBranchReport || isOrganizationReport;
    const isServiceNotice = message.purpose === "SERVICE_NOTICE";
    const isCollectionPurpose = !isReport && !isServiceNotice;
    if (
      message.organization.id !== message.organizationId
      || (isOrganizationReport
        ? message.branchId !== null || message.branch !== null
        : !message.branch || message.branch.organizationId !== message.organizationId)
    ) {
      return suppress("TENANT_MISMATCH");
    }
    let settings: Awaited<ReturnType<typeof tx.branchWhatsAppSettings.findFirst>> = null;
    if (message.branch) {
      const settingsRows = await tx.$queryRaw<Array<{ branchId: string }>>(Prisma.sql`
        SELECT "branchId"
        FROM "BranchWhatsAppSettings"
        WHERE "branchId" = ${message.branch.id}
        FOR UPDATE
      `);
      if (settingsRows.length !== 1) return suppress("BRANCH_DISABLED");
      settings = await tx.branchWhatsAppSettings.findFirst({
        where: {
          branchId: message.branch.id,
          organizationId: message.organizationId,
          senderId: message.senderId,
        },
      });
      if (!settings?.enabled) return suppress("BRANCH_DISABLED");
    }
    try {
      await EntitlementService.assertOrganizationEntitlement(
        message.organizationId,
        "WHATSAPP_AUTOMATION",
        tx
      );
      if (message.branch) {
        await EntitlementService.assertBranchWritable(message.branch.id, tx);
      } else {
        await EntitlementService.assertOrganizationWritable(message.organizationId, tx);
      }
    } catch {
      return suppress("ENTITLEMENT_REQUIRED");
    }
    if (
      message.sender.organizationId !== message.organizationId
      || message.sender.status !== "ACTIVE"
      || message.sender.providerMode !== resolveWhatsAppProviderMode(input.env)
    ) {
      return suppress("SENDER_INACTIVE");
    }
    await tx.whatsAppSenderSafetyState.upsert({
      where: { senderId: message.senderId },
      create: { senderId: message.senderId },
      update: {},
    });
    await tx.$queryRaw(Prisma.sql`
      SELECT "senderId"
      FROM "WhatsAppSenderSafetyState"
      WHERE "senderId" = ${message.senderId}
      FOR UPDATE
    `);
    const safetyState = await tx.whatsAppSenderSafetyState.findUnique({
      where: { senderId: message.senderId },
      select: { pausedAt: true, pauseRequestedAt: true },
    });
    if (safetyState?.pausedAt || safetyState?.pauseRequestedAt) {
      return hold("SENDER_SAFETY_PAUSED");
    }
    if (!/^[a-f0-9]{64}$/.test(message.dedupeKey)) {
      return suppress("DEDUPE_INVALID");
    }
    if (isServiceNotice && !isWhatsAppServiceNoticesEnabled(input.env)) {
      return suppress("SERVICE_NOTICES_DISABLED");
    }
    if (
      message.trigger === "AUTOMATION"
      && !isWhatsAppLiveAutomationOrganizationEnabled(message.organizationId, input.env)
    ) {
      return suppress("AUTOMATION_CANARY_REQUIRED");
    }
    if (
      message.budgetState !== "RESERVED"
      || message.estimatedCostMicros === null
      || !message.rateCardVersion
      || !message.budgetMonth
    ) {
      return suppress("BUDGET_RESERVATION_INVALID");
    }
    if (
      isCollectionPurpose
      && message.trigger === "AUTOMATION"
      && (
        !settings
        || !message.branch
        || !settings.automationEnabledAt
        || settings.configurationRevision !== message.settingsRevision
        || !message.automationStage
      )
    ) {
      return suppress("SETTINGS_REVISION_CHANGED");
    }
    if (isCollectionPurpose && message.trigger === "AUTOMATION" && message.automationStage) {
      if (!message.branch) return suppress("TENANT_MISMATCH");
      const rule = await tx.whatsAppAutomationRule.findUnique({
        where: { branchId_stage: { branchId: message.branch.id, stage: message.automationStage } },
      });
      if (!rule?.enabled) return suppress("AUTOMATION_DISABLED");
    }

    let language: WhatsAppManagedTemplateLanguage | null = null;
    if (isReport) {
      const source = await verifyWhatsAppReportMessageSource({
        tx,
        messageId: message.id,
        now: validationNow,
        env: input.env,
      });
      if (!source.valid) return suppress(source.code);
      language = source.language;
    } else if (isServiceNotice) {
      const source = await verifyWhatsAppServiceNoticeSource({
        tx,
        messageId: message.id,
        now: validationNow,
      });
      if (!source.valid) return suppress(source.code);
      language = source.language;
    } else if (settings) {
      language = normalizeLanguage(settings.defaultLanguage);
    }
    if (
      !language
      || !message.managedTemplateKey
      || !message.catalogVersion
      || !message.catalogHash
      || message.templateVersion === null
    ) {
      return suppress("TEMPLATE_COMPONENT_MISMATCH");
    }
    if (!message.templateBinding) return suppress("TEMPLATE_NOT_BOUND");
    if (
      message.templateBinding.senderId !== message.senderId
      || message.templateBinding.managedKey !== message.managedTemplateKey
      || message.templateBinding.templateId !== message.templateId
      || message.templateBinding.language !== language
      || message.templateBinding.template.version !== message.templateVersion
      || message.templateBinding.provisioning.senderId !== message.senderId
      || message.templateBinding.provisioning.managedKey !== message.managedTemplateKey
      || message.templateBinding.provisioning.language !== language
      || message.templateBinding.provisioning.catalogVersion !== message.catalogVersion
      || message.templateBinding.provisioning.catalogHash !== message.catalogHash
      || message.templateBinding.provisioning.providerTemplateId
        !== message.templateBinding.template.providerTemplateId
      || !Array.isArray(message.templateBinding.template.components)
    ) {
      return suppress("TEMPLATE_COMPONENT_MISMATCH");
    }
    if (message.templateBinding.template.staleAt !== null) return suppress("TEMPLATE_STALE");
    if (message.templateBinding.template.category !== "UTILITY") {
      return suppress("TEMPLATE_NOT_UTILITY");
    }
    if (
      !message.templateBinding.active
      || message.templateBinding.provisioning.status !== "READY"
      || message.templateBinding.template.providerStatus !== "APPROVED"
    ) return suppress("TEMPLATE_NOT_APPROVED");
    let definition: ReturnType<typeof getManagedWhatsAppTemplate>;
    try {
      definition = getManagedWhatsAppTemplate(
        message.managedTemplateKey as WhatsAppManagedTemplateKey,
        language,
        message.catalogVersion
      );
    } catch {
      return suppress("TEMPLATE_COMPONENT_MISMATCH");
    }
    if (
      definition.catalogHash !== message.catalogHash
      || message.templateBinding.catalogHash !== definition.catalogHash
      || message.templateBinding.catalogVersion !== definition.catalogVersion
      || !managedProviderTemplateMatches({
        name: message.templateBinding.template.name,
        language: message.templateBinding.template.language,
        category: message.templateBinding.template.category,
        components: message.templateBinding.template.components,
      }, definition)
    ) {
      return suppress("TEMPLATE_COMPONENT_MISMATCH");
    }
    const values = jsonRecord(message.templateVariables);
    if (!values) return suppress("SOURCE_CHANGED");
    let preparedValues: ReturnType<typeof prepareManagedWhatsAppTemplate>;
    try {
      preparedValues = prepareManagedWhatsAppTemplate(definition, values);
    } catch {
      return suppress("SOURCE_CHANGED");
    }

    if (isCollectionPurpose) {
      if (!message.branch || !settings) return suppress("BRANCH_DISABLED");
      const studentIds = new Set<string>();
      if (message.studentId) studentIds.add(message.studentId);
      for (const source of message.paymentSources) studentIds.add(source.payment.studentId);
      if (message.student && message.student.status !== "ACTIVE") return suppress("STUDENT_INACTIVE");
      if (message.paymentSources.some(source => source.payment.student.status !== "ACTIVE")) {
        return suppress("STUDENT_INACTIVE");
      }
      if (message.trigger === "MANUAL" && message.paymentSources.some(source => {
        const phone = source.payment.student.phone;
        if (!phone) return true;
        try {
          return normalizeWhatsAppPhone(phone, { defaultCountry: "IN" })
            !== message.recipientPhoneE164;
        } catch {
          return true;
        }
      })) {
        return suppress("RECIPIENT_ASSOCIATION_STALE");
      }
      let activeRecipients: Array<{ id: string; studentId: string }> = [];
      if (studentIds.size > 0) {
        activeRecipients = await tx.whatsAppStudentRecipient.findMany({
          where: {
            organizationId: message.organizationId,
            branchId: message.branch.id,
            senderId: message.senderId,
            phoneE164: message.recipientPhoneE164,
            studentId: { in: [...studentIds] },
            status: "ACTIVE",
            consent: {
              senderId: message.senderId,
              phoneE164: message.recipientPhoneE164,
              consentType: "OPERATIONAL",
              status: "OPTED_IN",
            },
          },
          select: { id: true, studentId: true },
        });
        if (
          activeRecipients.length !== studentIds.size
          || new Set(activeRecipients.map(recipient => recipient.studentId)).size !== studentIds.size
        ) return suppress("RECIPIENT_ASSOCIATION_STALE");
      }

      if (message.trigger === "AUTOMATION") {
        const source = await verifyAutomaticMessageSource({
          tx,
          messageId: message.id,
          now: validationNow,
        });
        if (!source.valid) return suppress(source.code);
      } else {
        if (
          message.purpose !== "MANUAL_REMINDER"
          || message.settingsRevision === null
          || message.settingsRevision !== settings.configurationRevision
          || message.paymentSources.length < 1
        ) return suppress("SOURCE_CHANGED");
        let content: ReturnType<typeof deriveWhatsAppManualCollectionContent>;
        try {
          content = deriveWhatsAppManualCollectionContent({
            payments: message.paymentSources.map(source => source.payment),
            language,
            tone: settings.defaultTone,
            branchName: message.branch.name,
            timeZone: message.branch.organization.timezone,
            at: validationNow,
          });
        } catch {
          return suppress("SOURCE_CHANGED");
        }
        if (content.managedTemplateKey !== message.managedTemplateKey) {
          return suppress("SOURCE_CHANGED");
        }
        let currentPrepared: ReturnType<typeof prepareManagedWhatsAppTemplate>;
        try {
          currentPrepared = prepareManagedWhatsAppTemplate(definition, content.values);
        } catch {
          return suppress("SOURCE_CHANGED");
        }
        if (JSON.stringify(currentPrepared.orderedValues) !== JSON.stringify(preparedValues.orderedValues)) {
          return suppress("SOURCE_CHANGED");
        }
        const expectedFingerprint = createWhatsAppManualSourceFingerprint({
          branchId: message.branch.id,
          branchName: message.branch.name,
          senderId: message.senderId,
          recipientIds: activeRecipients.map(recipient => recipient.id),
          paymentFacts: message.paymentSources.map(source => ({
            id: source.payment.id,
            status: source.payment.status,
            amount: source.payment.amount,
            dueDate: source.payment.dueDate,
            studentId: source.payment.studentId,
            studentName: source.payment.student.name,
          })),
          templateBindingId: message.templateBinding.id,
          catalogHash: message.catalogHash,
          settingsRevision: settings.configurationRevision,
          managedTemplateKey: message.managedTemplateKey,
          templateVariables: content.values,
        });
        if (expectedFingerprint !== message.sourceFingerprint) return suppress("SOURCE_CHANGED");
      }

      if (["MANUAL_REMINDER", "FEE_RENEWAL", "PAST_DUE"].includes(message.purpose)) {
        if (message.paymentSources.length > 0 && message.paymentSources.some(source => source.payment.status !== "DUE")) {
          return suppress("PAYMENT_RESOLVED");
        }
        // Pre-due FEE_RENEWAL messages intentionally have no Payment rows: they
        // are derived from upcoming billing cycles. Shared-phone groups can also
        // span students, leaving studentId null. Their exact source truth is
        // revalidated above by verifyAutomaticMessageSource.
        if (
          message.purpose !== "FEE_RENEWAL"
          && message.paymentSources.length === 0
          && !message.studentId
        ) {
          return suppress("SOURCE_CHANGED");
        }
      }
      if (message.purpose === "WELCOME") {
        if (
          !message.student
          || message.student.enrollmentSource !== "MANUAL"
          || !settings.automationEnabledAt
          || message.student.createdAt < settings.automationEnabledAt
        ) {
          return suppress("SOURCE_CHANGED");
        }
      }
      if (message.purpose === "PAYMENT_CONFIRMATION") {
        const event = message.paymentResolutionEvent;
        if (
          !event
          || event.source !== "PAYMENT_ACTION"
          || event.toStatus !== "PAID"
          || event.payment.status !== "PAID"
          || !settings.automationEnabledAt
          || event.occurredAt < settings.automationEnabledAt
        ) {
          return suppress("PAYMENT_RESOLVED");
        }
      }
      if (message.purpose === "PAYMENT_CORRECTION") {
        const event = message.paymentResolutionEvent;
        if (
          !event
          || event.source !== "PAYMENT_ACTION"
          || event.fromStatus !== "PAID"
          || event.toStatus !== "WAIVED"
          || event.payment.status !== "WAIVED"
        ) {
          return suppress("SOURCE_CHANGED");
        }
      }
    }

    // Take a second clock reading at the final local boundary before the
    // provider mutation. Earlier messages in the same batch may have consumed
    // most or all of their original claim leases.
    const submissionNow = input.clock();
    let rateCard: ReturnType<typeof resolveWhatsAppUtilityRate>;
    try {
      rateCard = resolveWhatsAppUtilityRate({
        recipientPhoneE164: message.recipientPhoneE164,
        at: submissionNow,
        env: input.env,
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "DESTINATION_UNSUPPORTED")) {
        try {
          const configuredCard = readWhatsAppRateCard(input.env);
          if (getWhatsAppRateCardStatus(configuredCard, submissionNow) === "EXPIRED") {
            await WhatsAppIncidentService.createOrTouchInTransaction({
              tx,
              organizationId: message.organizationId,
              branchId: message.branchId,
              senderId: message.senderId,
              type: "RATE_CARD_EXPIRED",
              severity: "CRITICAL",
              dedupeKey: `sender:${message.senderId}:rate-card`,
              safeCode: "RATE_CARD_EXPIRED",
              details: { rateCardVersion: configuredCard.version },
              now: submissionNow,
            });
          }
        } catch {
          // Missing or malformed configuration fails closed without inventing
          // an expiry incident whose provider/operator truth is unknown.
        }
      }
      return suppress(error instanceof Error && "code" in error && error.code === "DESTINATION_UNSUPPORTED"
        ? "DESTINATION_UNSUPPORTED"
        : "RATE_UNAVAILABLE");
    }
    let budgetMicros: number;
    let budgetMonth: string;
    let used: { _sum: { estimatedCostMicros: bigint | null } };
    try {
      if (isOrganizationReport) {
        await tx.$queryRaw(Prisma.sql`
          SELECT "organizationId"
          FROM "OrganizationWhatsAppReportSettings"
          WHERE "organizationId" = ${message.organizationId}
          FOR UPDATE
        `);
        const organizationSettings = await tx.organizationWhatsAppReportSettings.findFirst({
          where: {
            organizationId: message.organizationId,
            senderId: message.senderId,
            enabled: true,
          },
        });
        budgetMicros = paiseToInrMicros(
          validateWhatsAppMonthlyBudgetMinor(organizationSettings?.monthlyBudgetMinor)
        );
        budgetMonth = whatsappBudgetMonth(submissionNow, message.organization.timezone);
        used = await tx.whatsAppMessage.aggregate({
          where: {
            organizationId: message.organizationId,
            branchId: null,
            purpose: "DAILY_ORGANIZATION_REPORT",
            budgetMonth,
            budgetState: { in: ["RESERVED", "COMMITTED"] },
            id: { not: message.id },
          },
          _sum: { estimatedCostMicros: true },
        });
      } else {
        if (!message.branch || !settings) throw new Error("Branch budget is unavailable");
        budgetMicros = paiseToInrMicros(
          validateWhatsAppMonthlyBudgetMinor(settings.monthlyBudgetMinor)
        );
        budgetMonth = whatsappBudgetMonth(submissionNow, message.branch.organization.timezone);
        used = await tx.whatsAppMessage.aggregate({
          where: {
            branchId: message.branch.id,
            budgetMonth,
            budgetState: { in: ["RESERVED", "COMMITTED"] },
            id: { not: message.id },
          },
          _sum: { estimatedCostMicros: true },
        });
      }
    } catch {
      return suppress("BUDGET_EXHAUSTED");
    }
    if ((used._sum.estimatedCostMicros ?? 0n) + BigInt(rateCard.rateMicros) > BigInt(budgetMicros)) {
      return suppress("BUDGET_EXHAUSTED");
    }

    const transitioned = await tx.whatsAppMessage.updateMany({
      where: { id: message.id, leaseToken: input.leaseToken, status: "CLAIMED" },
      data: {
        status: "SUBMITTING",
        submissionStartedAt: submissionNow,
        providerCallAdmittedAt: null,
        budgetMonth,
        budgetState: "RESERVED",
        rateCardVersion: rateCard.version,
        estimatedCostMicros: BigInt(rateCard.rateMicros),
        leaseUntil: new Date(
          submissionNow.getTime() + WHATSAPP_DISPATCH_PROVIDER_LEASE_MS
        ),
      },
    });
    if (transitioned.count !== 1) return { kind: "STALE" as const };
    return {
      kind: "READY" as const,
      submission: {
        messageId: message.id,
        leaseToken: input.leaseToken,
        organizationId: message.organizationId,
        branchId: message.branchId,
        senderId: message.senderId,
        serviceNoticeId: message.serviceNoticeId,
        phoneNumberId: message.sender.phoneNumberId,
        recipientPhoneE164: message.recipientPhoneE164,
        definition,
        values,
        attemptCount: message.attemptCount + 1,
        previousAttemptCount: message.attemptCount,
        previousLastAttemptAt: message.lastAttemptAt,
      },
    };
  });
}

type AttachedWebhookEvent = Readonly<{
  id: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  providerTimestamp: Date | null;
  receivedAt: Date;
  providerRecipientWaId: string | null;
  providerBillable: boolean | null;
  providerPricingCategory: string | null;
  safeErrorCode: string | null;
}>;

export function projectAttachedWhatsAppWebhookEvents(
  events: readonly AttachedWebhookEvent[]
) {
  const ordered = [...events].sort((left, right) => {
    const timeDifference = (left.providerTimestamp ?? left.receivedAt).getTime()
      - (right.providerTimestamp ?? right.receivedAt).getTime();
    return timeDifference || left.id.localeCompare(right.id);
  });
  const projection = projectWhatsAppStatus(
    { status: "ACCEPTED", providerStatusTimestamp: null },
    ordered.map(event => ({
      status: event.status,
      providerTimestamp: event.providerTimestamp,
      stableOrder: event.id,
    }))
  );
  const firstOf = (...statuses: AttachedWebhookEvent["status"][]) =>
    ordered.find(event => statuses.includes(event.status));
  const occurredAt = (event: AttachedWebhookEvent | undefined) =>
    event ? event.providerTimestamp ?? event.receivedAt : null;
  const latestWith = <K extends keyof AttachedWebhookEvent>(key: K) =>
    [...ordered].reverse().find(event => event[key] !== null)?.[key] ?? null;
  const projectedFailure = projection.status === "FAILED"
    ? [...ordered].reverse().find(event => event.status === "FAILED")
    : undefined;

  return {
    status: projection.status,
    providerStatusTimestamp: projection.providerStatusTimestamp,
    providerRecipientWaId: latestWith("providerRecipientWaId") as string | null,
    providerBillable: latestWith("providerBillable") as boolean | null,
    providerPricingCategory: latestWith("providerPricingCategory") as string | null,
    sentAt: occurredAt(firstOf("SENT", "DELIVERED", "READ")),
    deliveredAt: occurredAt(firstOf("DELIVERED", "READ")),
    readAt: occurredAt(firstOf("READ")),
    failedAt: projection.status === "FAILED" ? occurredAt(projectedFailure) : null,
    failureCode: projection.status === "FAILED"
      ? projectedFailure?.safeErrorCode ?? "META_FAILED"
      : null,
    safeFailureMessage: null,
  } satisfies Prisma.WhatsAppMessageUpdateInput;
}

async function finalizeAccepted(input: {
  submission: PreparedWhatsAppSubmission;
  result: Awaited<ReturnType<MetaWhatsAppProviderClient["sendApprovedUtilityTemplate"]>>;
  now: Date;
}) {
  return prisma.$transaction(async tx => {
    await lockWhatsAppProviderMessage(tx, {
      senderId: input.submission.senderId,
      providerMessageId: input.result.providerMessageId,
    });
    const updated = await tx.whatsAppMessage.updateMany({
      where: {
        id: input.submission.messageId,
        leaseToken: input.submission.leaseToken,
        status: "SUBMITTING",
      },
      data: {
        status: "ACCEPTED",
        providerMessageId: input.result.providerMessageId,
        providerRecipientWaId: input.result.providerRecipientWaId,
        acceptedAt: input.now,
        budgetState: "COMMITTED",
        failureCode: null,
        safeFailureMessage: input.result.submissionStatus === "HELD_FOR_QUALITY_ASSESSMENT"
          ? "Provider accepted the message and is assessing delivery quality"
          : input.result.submissionStatus === "PAUSED"
            ? "Provider accepted the message but reported a paused submission"
            : null,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    if (updated.count !== 1) return false;
    await WhatsAppSenderSafetyService.recordAcceptedInTransaction({
      tx,
      organizationId: input.submission.organizationId,
      senderId: input.submission.senderId,
      at: input.now,
    });
    await tx.whatsAppMessageEvent.create({
      data: {
        messageId: input.submission.messageId,
        senderId: input.submission.senderId,
        providerMessageId: input.result.providerMessageId,
        eventKey: sha256(`provider-response:${input.result.providerMessageId}`),
        source: "PROVIDER_RESPONSE",
        status: "ACCEPTED",
        providerTimestamp: input.now,
        payloadHash: sha256(JSON.stringify({
          providerMessageId: input.result.providerMessageId,
          submissionStatus: input.result.submissionStatus,
        })),
      },
    });
    await tx.whatsAppMessageEvent.updateMany({
      where: {
        senderId: input.submission.senderId,
        providerMessageId: input.result.providerMessageId,
        messageId: null,
      },
      data: { messageId: input.submission.messageId, expiresAt: null },
    });
    const events = await tx.whatsAppMessageEvent.findMany({
      where: {
        messageId: input.submission.messageId,
        source: "PROVIDER_WEBHOOK",
        status: { in: ["SENT", "DELIVERED", "READ", "FAILED"] },
      },
      orderBy: [{ providerTimestamp: "asc" }, { id: "asc" }],
      select: {
        id: true,
        status: true,
        providerTimestamp: true,
        receivedAt: true,
        providerRecipientWaId: true,
        providerBillable: true,
        providerPricingCategory: true,
        safeErrorCode: true,
      },
    });
    if (events.length > 0) {
      const projection = projectAttachedWhatsAppWebhookEvents(
        events as AttachedWebhookEvent[]
      );
      await tx.whatsAppMessage.update({
        where: { id: input.submission.messageId },
        data: {
          ...projection,
          providerRecipientWaId:
            projection.providerRecipientWaId ?? input.result.providerRecipientWaId,
        },
      });
      if (projection.status === "DELIVERED" || projection.status === "READ") {
        await WhatsAppSenderSafetyService.recordDeliveredInTransaction({
          tx,
          organizationId: input.submission.organizationId,
          senderId: input.submission.senderId,
          at: projection.deliveredAt ?? input.now,
        });
      }
    }
    if (input.submission.serviceNoticeId) {
      await WhatsAppServiceNoticeService.reconcileStatusInTransaction({
        tx,
        noticeId: input.submission.serviceNoticeId,
        now: input.now,
      });
    }
    await WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
      tx,
      organizationId: input.submission.organizationId,
      senderId: input.submission.senderId,
      now: input.now,
    });
    return true;
  });
}

async function finalizeProviderFailure(input: {
  submission: PreparedWhatsAppSubmission;
  disposition: DispatchErrorDisposition;
  error: unknown;
  now: Date;
}) {
  if (input.disposition === "RATE_LIMIT" && input.submission.attemptCount < MAX_WHATSAPP_DISPATCH_ATTEMPTS) {
    const retryAt = calculateWhatsAppRetryAt({
      now: input.now,
      attemptCount: input.submission.attemptCount,
      retryAfterSeconds: input.error instanceof MetaWhatsAppProviderError
        ? input.error.retryAfterSeconds
        : null,
    });
    return prisma.$transaction(async tx => {
      const result = await tx.whatsAppMessage.updateMany({
        where: {
          id: input.submission.messageId,
          leaseToken: input.submission.leaseToken,
          status: "SUBMITTING",
        },
        data: {
          status: "SCHEDULED",
          submissionStartedAt: null,
          providerCallAdmittedAt: null,
          availableAt: retryAt,
          failureCode: "PROVIDER_RATE_LIMIT",
          budgetState: "RESERVED",
          leaseToken: null,
          leaseUntil: null,
        },
      });
      if (result.count !== 1) return "STALE" as const;
      await WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
        tx,
        organizationId: input.submission.organizationId,
        senderId: input.submission.senderId,
        now: input.now,
      });
      return "RETRIED" as const;
    });
  }
  const ambiguous = input.disposition === "AMBIGUOUS";
  return prisma.$transaction(async tx => {
    const result = await tx.whatsAppMessage.updateMany({
      where: {
        id: input.submission.messageId,
        leaseToken: input.submission.leaseToken,
        status: "SUBMITTING",
      },
      data: {
        status: ambiguous ? "UNKNOWN" : "FAILED",
        failureCode: ambiguous ? "PROVIDER_UNKNOWN_OUTCOME" : "PROVIDER_REJECTED",
        safeFailureMessage: ambiguous
          ? "Provider acceptance could not be confirmed. Lab Lords will not retry automatically because that could send a duplicate message."
          : "The provider did not accept this message",
        ...(ambiguous ? {} : { failedAt: input.now }),
        budgetState: ambiguous ? "COMMITTED" : "RELEASED",
        leaseToken: null,
        leaseUntil: null,
      },
    });
    if (result.count !== 1) return "STALE" as const;
    if (ambiguous) {
      await WhatsAppSenderSafetyService.recordAmbiguousOutcomeInTransaction({
        tx,
        organizationId: input.submission.organizationId,
        branchId: input.submission.branchId,
        senderId: input.submission.senderId,
        messageId: input.submission.messageId,
        now: input.now,
      });
    } else if (input.error instanceof MetaWhatsAppProviderError) {
      await WhatsAppSenderSafetyService.recordDefiniteFailureInTransaction({
        tx,
        organizationId: input.submission.organizationId,
        senderId: input.submission.senderId,
        evidence: {
          kind: input.error.kind,
          providerCode: input.error.providerCode,
          providerSubcode: input.error.providerSubcode,
        },
        now: input.now,
      });
    }
    if (input.submission.serviceNoticeId) {
      await WhatsAppServiceNoticeService.reconcileStatusInTransaction({
        tx,
        noticeId: input.submission.serviceNoticeId,
        now: input.now,
      });
    }
    await WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
      tx,
      organizationId: input.submission.organizationId,
      senderId: input.submission.senderId,
      now: input.now,
    });
    return ambiguous ? "UNKNOWN" as const : "FAILED" as const;
  });
}

export class WhatsAppDispatcherService {
  static async run(input: {
    now?: Date;
    clock?: DispatchClock;
    limit?: number;
    invocationId?: string;
    env?: Readonly<Record<string, string | undefined>>;
    provider?: MetaWhatsAppProviderClient;
  } = {}) {
    const env = input.env ?? process.env;
    const operationClock = createWhatsAppDispatchOperationClock({
      now: input.now,
      clock: input.clock,
    });
    const batchNow = input.now ? new Date(input.now.getTime()) : operationClock();
    const limit = input.limit ?? DEFAULT_WHATSAPP_DISPATCH_BATCH;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WHATSAPP_DISPATCH_BATCH) {
      throw new Error("WhatsApp dispatcher batch limit is invalid");
    }
    if (!isWhatsAppIntegrationEnabled(env) || !flagEnabled(env[WHATSAPP_META_MESSAGE_WRITES_FLAG])) {
      return {
        held: true,
        messagesClaimed: 0,
        messagesAccepted: 0,
        messagesRetried: 0,
        messagesFailed: 0,
        messagesUnknown: 0,
        messagesSuppressed: 0,
        backlogRemaining: 0,
      };
    }

    const started = await WhatsAppJobRunService.start({
      jobType: "DISPATCHER",
      invocationId: input.invocationId ?? `dispatcher:${randomUUID()}`,
      providerMode: resolveWhatsAppProviderMode(env),
      now: batchNow,
    });
    if (!started.created) {
      return {
        held: started.run.status === "HELD",
        replayed: true as const,
        status: started.run.status,
        messagesClaimed: 0,
        messagesAccepted: 0,
        messagesRetried: 0,
        messagesFailed: 0,
        messagesUnknown: 0,
        messagesSuppressed: 0,
        staleClaimsRecovered: 0,
        staleSubmissionsMarkedUnknown: 0,
        backlogRemaining: 0,
      };
    }
    const evidenceCounts = {
      messagesClaimed: 0,
      messagesAccepted: 0,
      messagesRetried: 0,
      messagesFailed: 0,
      messagesUnknown: 0,
      messagesSuppressed: 0,
      staleClaimsRecovered: 0,
      staleSubmissionsMarkedUnknown: 0,
      backlogRemaining: 0,
    };
    try {
      const organizationScope = resolveWhatsAppDispatchOrganizationScope(env);
      const claim = await claimMessages(
        batchNow,
        limit,
        organizationScope,
        resolveWhatsAppProviderMode(env)
      );
      const counts = {
      held: false,
      replayed: false as const,
      messagesClaimed: claim.claimed.length,
      messagesAccepted: 0,
      messagesRetried: 0,
      messagesFailed: 0,
      messagesUnknown: claim.staleSubmitting,
      messagesSuppressed: 0,
      staleClaimsRecovered: claim.staleClaimed,
      staleSubmissionsMarkedUnknown: claim.staleSubmitting,
      backlogRemaining: 0,
      };
      const provider = input.provider ?? getMetaWhatsAppClient();
      for (const claimed of claim.claimed) {
      if (!areWhatsAppMessageWritesEnabled(claimed.organizationId, env)) {
        await releaseClaim({ messageId: claimed.id, leaseToken: claimed.leaseToken });
        continue;
      }
      const prepared = await prepareSubmission({
        messageId: claimed.id,
        leaseToken: claimed.leaseToken,
        clock: operationClock,
        env,
      });
      if (prepared.kind === "SUPPRESSED") {
        counts.messagesSuppressed += 1;
        continue;
      }
      if (prepared.kind !== "READY") continue;
      const admission = await admitPreparedWhatsAppSubmission({
        submission: prepared.submission,
        admittedAt: operationClock(),
        clock: operationClock,
      });
      if (admission !== "READY") continue;
      try {
        const result = await provider.sendApprovedUtilityTemplate({
          phoneNumberId: prepared.submission.phoneNumberId,
          recipientPhoneE164: prepared.submission.recipientPhoneE164,
          definition: prepared.submission.definition,
          values: prepared.submission.values,
          correlationId: prepared.submission.messageId,
        });
        if (await finalizeAccepted({
          submission: prepared.submission,
          result,
          now: operationClock(),
        })) {
          counts.messagesAccepted += 1;
        }
      } catch (error) {
        const outcome = await finalizeProviderFailure({
          submission: prepared.submission,
          disposition: classifyWhatsAppDispatchError(error),
          error,
          now: operationClock(),
        });
        if (outcome === "RETRIED") counts.messagesRetried += 1;
        if (outcome === "FAILED") counts.messagesFailed += 1;
        if (outcome === "UNKNOWN") counts.messagesUnknown += 1;
      }
      }
      counts.backlogRemaining = await prisma.whatsAppMessage.count({
        where: {
          status: "SCHEDULED",
          availableAt: { lte: batchNow },
          ...(organizationScope === null
            ? {}
            : { organizationId: { in: organizationScope } }),
        },
      });
      Object.assign(evidenceCounts, {
        messagesClaimed: counts.messagesClaimed,
        messagesAccepted: counts.messagesAccepted,
        messagesRetried: counts.messagesRetried,
        messagesFailed: counts.messagesFailed,
        messagesUnknown: counts.messagesUnknown,
        messagesSuppressed: counts.messagesSuppressed,
        staleClaimsRecovered: counts.staleClaimsRecovered,
        staleSubmissionsMarkedUnknown: counts.staleSubmissionsMarkedUnknown,
        backlogRemaining: counts.backlogRemaining,
      });
      const jobStatus = counts.messagesFailed > 0 || counts.messagesUnknown > 0
        ? "PARTIAL" as const
        : "SUCCEEDED" as const;
      await WhatsAppJobRunService.finish({
        runId: started.run.id,
        status: jobStatus,
        counts: evidenceCounts,
        safeErrorCode: jobStatus === "PARTIAL" ? "DISPATCH_REVIEW_REQUIRED" : null,
        now: operationClock(),
      });
      return { ...counts, status: jobStatus };
    } catch (error) {
      await WhatsAppJobRunService.finish({
        runId: started.run.id,
        status: "FAILED",
        counts: evidenceCounts,
        safeErrorCode: "DISPATCHER_FAILED",
        now: operationClock(),
      });
      throw error;
    }
  }
}
